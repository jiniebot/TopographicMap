// =============================================================================
// Union and Merge Operations
// Boolean union operations for merging overlapping features and road segments
// =============================================================================

// ===== Overlap Masking =====
// Create masks for overlapping areas between different road types
function applyOverlapMaskForRoads(layer, catConfig, prefixes = []) {
  const roadPolys = [];
  layer.eachLayer((poly) => {
    if (!poly._objectName) return;
    const prefix = poly._objectPrefix || poly._objectName.split("_")[0];
    if (prefixes.includes(prefix)) {
      const coords = poly._localRings?.[0] || poly._rotatedCorners || [];
      if (coords && coords.length >= 3) {
        const ring = [...coords, coords[0]];
        roadPolys.push({
          prefix,
          turf: turf.polygon([ring]),
        });
      }
    }
  });

  if (roadPolys.length < 2) return;

  const intersections = [];
  for (let i = 0; i < roadPolys.length; i++) {
    for (let j = i + 1; j < roadPolys.length; j++) {
      if (roadPolys[i].prefix === roadPolys[j].prefix) continue;
      try {
        const inter = turf.intersect(roadPolys[i].turf, roadPolys[j].turf);
        if (inter && inter.geometry) {
          intersections.push(inter);
        }
      } catch (e) {
        console.warn("[ROAD OVERLAP] intersect failed", e);
      }
    }
  }

  if (intersections.length === 0) return;

  const addGeo = (rings) => {
    const cleaned = cleanupShortSegments(rings, 1.0);
    const leafletPoly = createLeafletPolygonFromLocal(cleaned, catConfig, {
      strokeOpacityOverride: 0, // hide strokes in overlap
    });
    layer.addLayer(leafletPoly);
  };

  intersections.forEach((feat) => {
    const geom = feat.geometry;
    if (geom.type === "Polygon") {
      const rings = geom.coordinates;
      if (rings && rings.length > 0) {
        addGeo(rings.map((r) => r.map(([x, z]) => [x, z])));
      }
    } else if (geom.type === "MultiPolygon") {
      geom.coordinates.forEach((polyCoords) => {
        if (polyCoords && polyCoords[0]) {
          addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
        }
      });
    }
  });
}

// Hide strokes only where different road categories overlap (e.g., asf vs city vs mud)
function applyOverlapMaskForRoadCategories(
  layer,
  catConfig,
  categoryName,
  categoryLayers,
  categories = []
) {
  const otherCategories = categories.filter((c) => c !== categoryName);
  if (otherCategories.length === 0) return;

  const toTurfPoly = (poly) => {
    const rings =
      poly._localRings ||
      (poly._rotatedCorners ? [poly._rotatedCorners] : null);
    if (!rings || !rings.length) return null;
    const closed = rings
      .map((r) => {
        if (!r || r.length < 3) return null;
        const first = r[0];
        const last = r[r.length - 1];
        if (first[0] === last[0] && first[1] === last[1]) return r;
        return [...r, first];
      })
      .filter(Boolean);
    if (!closed.length) return null;
    return turf.polygon(closed);
  };

  const currentPolys = [];
  layer.eachLayer((poly) => {
    const turfPoly = toTurfPoly(poly);
    if (turfPoly)
      currentPolys.push({ turf: turfPoly, color: catConfig.fillColor });
  });
  if (currentPolys.length === 0) return;

  const otherPolys = [];
  otherCategories.forEach((cat) => {
    const otherLayer = categoryLayers[cat];
    const otherCatConfig = mapStyles?.categories?.[cat];
    if (!otherLayer) return;
    otherLayer.eachLayer((poly) => {
      const turfPoly = toTurfPoly(poly);
      const color =
        poly._catConfig?.fillColor ||
        otherCatConfig?.fillColor ||
        catConfig.fillColor;
      if (turfPoly) otherPolys.push({ turf: turfPoly, color });
    });
  });
  if (otherPolys.length === 0) return;

  const intersections = [];
  currentPolys.forEach((a) => {
    otherPolys.forEach((b) => {
      try {
        const inter = turf.intersect(a.turf, b.turf);
        if (inter && inter.geometry) {
          intersections.push({
            geometry: inter.geometry,
            colorA: a.color,
            colorB: b.color,
          });
        }
      } catch (e) {
        console.warn("[ROAD CATEGORY OVERLAP] intersect failed", e);
      }
    });
  });

  if (intersections.length === 0) return;

  intersections.forEach((feat) => {
    const geom = feat.geometry;
    const opts = {
      strokeOpacityOverride: 0,
      fillColorOverride: feat.colorA,
      fillOpacityOverride: 1,
    };
    if (geom.type === "Polygon") {
      const rings = geom.coordinates;
      if (rings && rings.length > 0) {
        const cleaned = cleanupShortSegments(
          rings.map((r) => r.map(([x, z]) => [x, z])),
          1.0
        );
        const leafletPoly = createLeafletPolygonFromLocal(
          cleaned,
          catConfig,
          opts
        );
        layer.addLayer(leafletPoly);
      }
    } else if (geom.type === "MultiPolygon") {
      geom.coordinates.forEach((polyCoords) => {
        if (polyCoords && polyCoords[0]) {
          const cleaned = cleanupShortSegments(
            polyCoords.map((r) => r.map(([x, z]) => [x, z])),
            1.0
          );
          const leafletPoly = createLeafletPolygonFromLocal(
            cleaned,
            catConfig,
            opts
          );
          layer.addLayer(leafletPoly);
        }
      });
    }
  });
}

// Apply stroke masking at intersections between different road prefixes
function applyIntersectionStrokeMasking(layer, catConfig, prefixes = []) {
  const roadsByPrefix = {};
  const roadsToMask = new Set();

  prefixes.forEach((prefix) => {
    roadsByPrefix[prefix] = [];
  });

  layer.eachLayer((poly) => {
    if (!poly._objectPrefix && !poly._objectName) return;
    const prefix =
      poly._objectPrefix ||
      prefixes.find((p) => poly._objectName?.startsWith(p)) ||
      null;

    if (prefix && roadsByPrefix[prefix]) {
      roadsByPrefix[prefix].push(poly);
    }
  });

  const prefixList = Object.keys(roadsByPrefix).filter(
    (k) => roadsByPrefix[k].length > 0
  );
  let maskCount = 0;

  for (let i = 0; i < prefixList.length; i++) {
    for (let j = i + 1; j < prefixList.length; j++) {
      const prefix1 = prefixList[i];
      const prefix2 = prefixList[j];
      const polys1 = roadsByPrefix[prefix1];
      const polys2 = roadsByPrefix[prefix2];

      if (polys1.length === 0 || polys2.length === 0) continue;

      polys1.forEach((p1) => {
        const latlngs1 = p1.getLatLngs();
        if (!latlngs1 || !latlngs1[0]) return;

        polys2.forEach((p2) => {
          const latlngs2 = p2.getLatLngs();
          if (!latlngs2 || !latlngs2[0]) return;

          try {
            const coords1 = (
              Array.isArray(latlngs1[0]) ? latlngs1[0] : latlngs1
            ).map((ll) => [ll.lng, ll.lat]);
            const coords2 = (
              Array.isArray(latlngs2[0]) ? latlngs2[0] : latlngs2
            ).map((ll) => [ll.lng, ll.lat]);

            if (
              coords1[0][0] !== coords1[coords1.length - 1][0] ||
              coords1[0][1] !== coords1[coords1.length - 1][1]
            ) {
              coords1.push(coords1[0]);
            }
            if (
              coords2[0][0] !== coords2[coords2.length - 1][0] ||
              coords2[0][1] !== coords2[coords2.length - 1][1]
            ) {
              coords2.push(coords2[0]);
            }

            const poly1 = turf.polygon([coords1]);
            const poly2 = turf.polygon([coords2]);
            const intersection = turf.intersect(poly1, poly2);
            if (!intersection || !intersection.geometry) return;

            const bufferedIntersection = turf.buffer(intersection, 0.0002, {
              units: "degrees",
            });

            const maskCoords =
              bufferedIntersection.geometry.type === "Polygon"
                ? bufferedIntersection.geometry.coordinates[0]
                : bufferedIntersection.geometry.coordinates.flatMap(
                    (p) => p[0]
                  );

            const maskLatLngs = maskCoords.map(([lng, lat]) =>
              L.latLng(lat, lng)
            );
            const maskFillColor = p1.options.fillColor || "#ffffff";
            const maskPoly = L.polygon(maskLatLngs, {
              stroke: false,
              fillColor: maskFillColor,
              fillOpacity: 1.0,
              className: "stroke-mask",
              smooth: false,
            });
            layer.addLayer(maskPoly);
            maskCount++;
          } catch (e) {}
        });
      });
    }
  }
}

// ===== Width Enforcement =====
// Enforce uniform width on line-type polygons while preserving length AND orientation
function enforceUniformWidth(layer, prefixes = [], catConfig = null) {
  const matched = [];
  const customDrawerMatched = [];

  prefixes.forEach((prefix) => {
    layer.eachLayer((poly) => {
      if (!poly._objectName) return;
      if (poly._objectName.startsWith(prefix)) {
        if (customObjectDrawers[poly._objectName]) {
          customDrawerMatched.push(poly);
        } else {
          matched.push(poly);
        }
      }
    });
  });

  if (matched.length === 0 && customDrawerMatched.length === 0) return;

  let targetWidth = catConfig?.uniformWidth || null;

  if (targetWidth === null || targetWidth === undefined) {
    let minDimension = Infinity;
    const allSegments = [...matched, ...customDrawerMatched];
    allSegments.forEach((poly) => {
      const rings =
        poly._localRings ||
        (poly._rotatedCorners ? [poly._rotatedCorners] : null);
      if (!rings) return;

      rings.forEach((ring) => {
        if (!ring || ring.length < 2) return;

        const xs = ring.map(([x, z]) => x);
        const zs = ring.map(([x, z]) => z);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minZ = Math.min(...zs);
        const maxZ = Math.max(...zs);

        const width = maxX - minX;
        const length = maxZ - minZ;
        const smallest = Math.min(width, length);

        if (smallest > 0 && smallest < minDimension) {
          minDimension = smallest;
        }
      });
    });

    if (minDimension === Infinity) return;
    targetWidth = minDimension;
  }

  if (catConfig) {
    catConfig.uniformWidth = targetWidth;
  }

  matched.forEach((poly) => {
    const needsDimensionFlip =
      poly._objectName === "asf1_6konec" ||
      poly._objectName === "asf2_6konec" ||
      poly._objectName === "asf3_6konec" ||
      poly._objectName === "city_6konec" ||
      poly._objectName === "asf1_6" ||
      poly._objectName === "asf2_6" ||
      poly._objectName === "asf3_6" ||
      poly._objectName === "city_6" ||
      poly._objectName === "rail_track_sp" ||
      poly._objectName === "rail_tracke_8" ||
      poly._objectName === "rail_tracke_4" ||
      poly._objectName === "rail_tracke_2";

    const rings =
      poly._localRings ||
      (poly._rotatedCorners ? [poly._rotatedCorners] : null);
    if (!rings) return;

    const newRings = rings.map((ring) => {
      if (!ring || ring.length < 4) return ring;

      const p0 = ring[0];
      const p1 = ring[1];
      const p2 = ring[2];
      const p3 = ring[3];

      const dist01 = Math.sqrt(
        Math.pow(p1[0] - p0[0], 2) + Math.pow(p1[1] - p0[1], 2)
      );
      const dist12 = Math.sqrt(
        Math.pow(p2[0] - p1[0], 2) + Math.pow(p2[1] - p1[1], 2)
      );

      const side1Length = dist01;
      const side2Length = dist12;

      let lengthEdgeIdx, lengthDist, widthDist;
      if (needsDimensionFlip) {
        if (side1Length <= side2Length) {
          lengthEdgeIdx = 0;
          lengthDist = side1Length;
          widthDist = side2Length;
        } else {
          lengthEdgeIdx = 1;
          lengthDist = side2Length;
          widthDist = side1Length;
        }
      } else {
        if (side1Length > side2Length) {
          lengthEdgeIdx = 0;
          lengthDist = side1Length;
          widthDist = side2Length;
        } else {
          lengthEdgeIdx = 1;
          lengthDist = side2Length;
          widthDist = side1Length;
        }
      }

      const lengthDir =
        lengthEdgeIdx === 0
          ? [(p1[0] - p0[0]) / lengthDist, (p1[1] - p0[1]) / lengthDist]
          : [(p2[0] - p1[0]) / lengthDist, (p2[1] - p1[1]) / lengthDist];

      const widthDir = [-lengthDir[1], lengthDir[0]];

      const centerX = (p0[0] + p1[0] + p2[0] + p3[0]) / 4;
      const centerZ = (p0[1] + p1[1] + p2[1] + p3[1]) / 4;

      const halfLength = lengthDist / 2;
      const halfWidth = targetWidth / 2;

      const newP0 = [
        centerX - lengthDir[0] * halfLength - widthDir[0] * halfWidth,
        centerZ - lengthDir[1] * halfLength - widthDir[1] * halfWidth,
      ];
      const newP1 = [
        centerX + lengthDir[0] * halfLength - widthDir[0] * halfWidth,
        centerZ + lengthDir[1] * halfLength - widthDir[1] * halfWidth,
      ];
      const newP2 = [
        centerX + lengthDir[0] * halfLength + widthDir[0] * halfWidth,
        centerZ + lengthDir[1] * halfLength + widthDir[1] * halfWidth,
      ];
      const newP3 = [
        centerX - lengthDir[0] * halfLength + widthDir[0] * halfWidth,
        centerZ - lengthDir[1] * halfLength + widthDir[1] * halfWidth,
      ];

      return [newP0, newP1, newP2, newP3];
    });

    poly._localRings = newRings;
    if (poly._rotatedCorners) {
      poly._rotatedCorners = newRings[0];
    }

    const leafletCorners = newRings[0].map(([cx, cz]) => {
      const px = (cx / config.mapSize) * WORLD_SIZE;
      const pz = (cz / config.mapSize) * WORLD_SIZE;
      const py = WORLD_SIZE - pz;
      return map.unproject(L.point(px, py), config.tileMaxZoom);
    });

    poly.setLatLngs(leafletCorners);
  });
}

// ===== Union Operations =====
// Synchronous union for road segments with same prefix
function applyUnionForRoadPrefixesV2(
  layer,
  catConfig,
  prefixes = [],
  bufferDist = 0.5,
  smallFeatureThreshold = 0.5
) {
  prefixes.forEach((prefix) => {
    const matched = [];
    layer.eachLayer((poly) => {
      if (!poly._objectName) return;
      if (
        poly._objectName.startsWith(prefix) ||
        (poly._isIntersection && poly._intersectionPrefix === prefix)
      ) {
        matched.push(poly);
      }
    });

    if (matched.length < 2) return;

    const turfPolys = matched
      .map((poly) => {
        const coords = poly._rotatedCorners || [];
        if (!coords || coords.length < 3) return null;
        const expandedRing =
          bufferDist > 0 ? expandRing(coords, bufferDist) : coords;
        const ring = [...expandedRing, expandedRing[0]];
        return turf.polygon([ring]);
      })
      .filter(Boolean);

    if (turfPolys.length < 2) return;

    let merged = turfPolys[0];
    for (let i = 1; i < turfPolys.length; i++) {
      try {
        merged = turf.union(merged, turfPolys[i]);
      } catch (e) {
        console.warn("Union failed for road piece", e);
      }
    }

    if (!merged || !merged.geometry) return;

    matched.forEach((p) => layer.removeLayer(p));

    const addGeo = (rings) => {
      const cleaned = cleanupShortSegments(rings, smallFeatureThreshold).map(
        (r) => smoothRing(r, bufferDist * 4)
      );
      const leafletPoly = createLeafletPolygonFromLocal(cleaned, catConfig);
      leafletPoly._objectName = `${prefix}_union`;
      leafletPoly._objectPrefix = prefix;
      leafletPoly._localRings = cleaned;
      layer.addLayer(leafletPoly);
    };

    if (merged.geometry.type === "Polygon") {
      const rings = merged.geometry.coordinates;
      if (rings && rings.length > 0) {
        addGeo(rings.map((r) => r.map(([x, z]) => [x, z])));
      }
    } else if (merged.geometry.type === "MultiPolygon") {
      merged.geometry.coordinates.forEach((polyCoords) => {
        if (polyCoords && polyCoords[0]) {
          addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
        }
      });
    }
  });
}

// Async version of union - yields to browser during processing
function applyUnionForRoadPrefixesV3(
  layer,
  catConfig,
  prefixes = [],
  bufferDist = 0.5,
  smallFeatureThreshold = 0.5
) {
  console.log(
    `[V3 UNION] Starting async union for prefixes: ${prefixes.join(", ")}`
  );
  let prefixIndex = 0;

  function processNextPrefix() {
    if (prefixIndex >= prefixes.length) {
      console.log(`[V3 UNION] All prefixes processed`);
      return;
    }

    const prefix = prefixes[prefixIndex];
    prefixIndex++;
    console.log(
      `[V3 UNION] Processing prefix ${prefixIndex}/${prefixes.length}: '${prefix}'`
    );

    const matched = [];
    layer.eachLayer((poly) => {
      if (!poly._objectName) return;
      if (
        poly._objectName.startsWith(prefix) ||
        (poly._isIntersection && poly._intersectionPrefix === prefix)
      ) {
        matched.push(poly);
      }
    });

    console.log(
      `[V3 UNION] Found ${matched.length} polygons for prefix '${prefix}'`
    );

    if (matched.length < 2) {
      console.log(
        `[V3 UNION] Skipping '${prefix}' - need at least 2 polygons, found ${matched.length}`
      );
      setTimeout(processNextPrefix, 10);
      return;
    }

    const turfPolys = matched
      .map((poly) => {
        const coords = poly._rotatedCorners || [];
        if (!coords || coords.length < 3) return null;
        const expandedRing =
          bufferDist > 0 ? expandRing(coords, bufferDist) : coords;
        const ring = [...expandedRing, expandedRing[0]];
        return turf.polygon([ring]);
      })
      .filter(Boolean);

    console.log(
      `[V3 UNION] Created ${turfPolys.length} turf polygons for '${prefix}'`
    );

    if (turfPolys.length < 2) {
      console.log(
        `[V3 UNION] Skipping '${prefix}' - insufficient valid turf polygons`
      );
      setTimeout(processNextPrefix, 10);
      return;
    }

    console.log(
      `[V3 UNION] Starting tree-based async union for '${prefix}' with ${turfPolys.length} polygons`
    );
    performUnionAsyncTree(
      turfPolys,
      prefix,
      matched,
      layer,
      catConfig,
      bufferDist,
      smallFeatureThreshold,
      () => {
        console.log(`[V3 UNION] Finished '${prefix}', moving to next`);
        setTimeout(processNextPrefix, 10);
      }
    );
  }

  processNextPrefix();
}

// Tree-based async union - divide and conquer approach
function performUnionAsyncTree(
  turfPolys,
  prefix,
  matched,
  layer,
  catConfig,
  bufferDist,
  smallFeatureThreshold,
  callback
) {
  console.log(
    `[V3 UNION] performUnionAsyncTree starting for '${prefix}' with ${turfPolys.length} polygons`
  );

  const batchSize = 10;
  let currentLevel = turfPolys.map((poly, idx) => ({ poly, idx }));
  let levelNumber = 0;

  function processLevel() {
    console.log(
      `[V3 UNION] Level ${levelNumber}: Processing ${currentLevel.length} items for '${prefix}'`
    );

    if (currentLevel.length === 1) {
      const finalMerged = currentLevel[0].poly;
      console.log(`[V3 UNION] Tree union complete for '${prefix}'`);
      finalizeUnion(
        finalMerged,
        prefix,
        matched,
        layer,
        catConfig,
        bufferDist,
        smallFeatureThreshold,
        callback
      );
      return;
    }

    const nextLevel = [];
    let batchIndex = 0;

    function processBatch() {
      if (batchIndex >= currentLevel.length) {
        levelNumber++;
        currentLevel = nextLevel;
        setTimeout(processLevel, 10);
        return;
      }

      const batchEnd = Math.min(batchIndex + batchSize, currentLevel.length);
      const batchItems = currentLevel.slice(batchIndex, batchEnd);

      console.log(
        `[V3 UNION] Level ${levelNumber} batch: items ${
          batchIndex + 1
        }-${batchEnd}/${currentLevel.length} for '${prefix}'`
      );

      let batchResult = batchItems[0].poly;
      for (let i = 1; i < batchItems.length; i++) {
        try {
          batchResult = turf.union(batchResult, batchItems[i].poly);
          console.log(
            `[V3 UNION] Level ${levelNumber}: Merged item ${
              batchIndex + i + 1
            }/${currentLevel.length}`
          );
        } catch (e) {
          console.warn(`[V3 UNION] Union failed at level ${levelNumber}:`, e);
        }
      }

      nextLevel.push({ poly: batchResult, idx: batchIndex });
      batchIndex = batchEnd;

      setTimeout(processBatch, 10);
    }

    processBatch();
  }

  processLevel();
}

// Async union processing in chunks
function performUnionAsync(
  turfPolys,
  prefix,
  matched,
  layer,
  catConfig,
  bufferDist,
  smallFeatureThreshold,
  callback
) {
  console.log(`[V3 UNION] performUnionAsync starting for '${prefix}'`);
  let merged = null;
  let index = 0;

  function processNextChunk() {
    const chunkSize = 3;
    const endIndex = Math.min(index + chunkSize, turfPolys.length);

    console.log(
      `[V3 UNION] Processing chunk for '${prefix}': ${index + 1}-${endIndex}/${
        turfPolys.length
      }`
    );

    for (let i = index; i < endIndex; i++) {
      try {
        if (merged === null) {
          merged = turfPolys[i];
          console.log(`[V3 UNION] Initialized merged with polygon ${i}`);
        } else {
          merged = turf.union(merged, turfPolys[i]);
          console.log(
            `[V3 UNION] Union complete: ${i + 1}/${turfPolys.length}`
          );
        }
      } catch (e) {
        console.warn(
          `[V3 UNION] Union failed for '${prefix}' at polygon ${i}:`,
          e
        );
      }
    }

    index = endIndex;

    if (index < turfPolys.length) {
      setTimeout(processNextChunk, 10);
    } else {
      console.log(
        `[V3 UNION] All unions complete for '${prefix}', finalizing...`
      );
      finalizeUnion(
        merged,
        prefix,
        matched,
        layer,
        catConfig,
        bufferDist,
        smallFeatureThreshold,
        callback
      );
    }
  }

  processNextChunk();
}

// Finalize union result and add to layer
function finalizeUnion(
  merged,
  prefix,
  matched,
  layer,
  catConfig,
  bufferDist,
  smallFeatureThreshold,
  callback
) {
  console.log(`[V3 UNION] finalizeUnion for '${prefix}'`);

  if (!merged || !merged.geometry) {
    console.warn(`[V3 UNION] No valid merged geometry for '${prefix}'`);
    if (callback) callback();
    return;
  }

  console.log(
    `[V3 UNION] Merged geometry type for '${prefix}': ${merged.geometry.type}`
  );
  console.log(
    `[V3 UNION] Removing ${matched.length} original polygons for '${prefix}'`
  );

  matched.forEach((p) => layer.removeLayer(p));

  let geoCount = 0;
  const addGeo = (rings) => {
    geoCount++;
    const cleaned = cleanupShortSegments(rings, smallFeatureThreshold).map(
      (r) => smoothRing(r, bufferDist * 4)
    );
    const leafletPoly = createLeafletPolygonFromLocal(cleaned, catConfig);
    leafletPoly._objectName = `${prefix}_union`;
    leafletPoly._objectPrefix = prefix;
    leafletPoly._localRings = cleaned;
    layer.addLayer(leafletPoly);
  };

  if (merged.geometry.type === "Polygon") {
    const rings = merged.geometry.coordinates;
    if (rings && rings.length > 0) {
      console.log(
        `[V3 UNION] Adding Polygon with ${rings.length} rings for '${prefix}'`
      );
      addGeo(rings.map((r) => r.map(([x, z]) => [x, z])));
    }
  } else if (merged.geometry.type === "MultiPolygon") {
    console.log(
      `[V3 UNION] Adding MultiPolygon with ${merged.geometry.coordinates.length} sub-polygons for '${prefix}'`
    );
    merged.geometry.coordinates.forEach((polyCoords) => {
      if (polyCoords && polyCoords[0]) {
        addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
      }
    });
  }

  console.log(`[V3 UNION] Added ${geoCount} merged geometries for '${prefix}'`);
  if (callback) callback();
}

// ===== Smart Rail Merging =====
// Smart union for rails - only merge on short sides (width), not long sides (length)
function applySmartUnionForRails(
  layer,
  catConfig,
  prefixes = [],
  smallFeatureThreshold = 0.5
) {
  prefixes.forEach((prefix) => {
    const matched = [];
    layer.eachLayer((poly) => {
      if (!poly._objectName) return;
      if (poly._objectName.startsWith(prefix)) {
        matched.push(poly);
      }
    });

    if (matched.length < 2) return;

    const mergeGroups = [];
    const processed = new Set();

    matched.forEach((poly, idx) => {
      if (processed.has(idx)) return;

      const group = [poly];
      processed.add(idx);
      const ring = poly._rotatedCorners || [];

      for (let i = idx + 1; i < matched.length; i++) {
        if (processed.has(i)) continue;
        const otherRing = matched[i]._rotatedCorners || [];

        if (shouldMergeRailSegments(ring, otherRing)) {
          group.push(matched[i]);
          processed.add(i);
        }
      }

      mergeGroups.push(group);
    });

    mergeGroups.forEach((group) => {
      if (group.length === 1) return;

      const turfPolys = group
        .map((poly) => {
          const coords = poly._rotatedCorners || [];
          if (!coords || coords.length < 3) return null;
          const ring = [...coords, coords[0]];
          return turf.polygon([ring]);
        })
        .filter(Boolean);

      if (turfPolys.length < 2) return;

      let merged = turfPolys[0];
      for (let i = 1; i < turfPolys.length; i++) {
        try {
          merged = turf.union(merged, turfPolys[i]);
        } catch (e) {
          console.warn("Rail union failed", e);
        }
      }

      if (!merged || !merged.geometry) return;

      group.forEach((p) => layer.removeLayer(p));

      const addGeo = (rings) => {
        const cleaned = cleanupShortSegments(rings, smallFeatureThreshold).map(
          (r) => smoothRing(r, 1.0)
        );
        const leafletPoly = createLeafletPolygonFromLocal(cleaned, catConfig);
        leafletPoly._objectName = `${prefix}_union`;
        leafletPoly._objectPrefix = prefix;
        leafletPoly._localRings = cleaned;
        layer.addLayer(leafletPoly);
      };

      if (merged.geometry.type === "Polygon") {
        const rings = merged.geometry.coordinates;
        if (rings && rings.length > 0) {
          addGeo(rings.map((r) => r.map(([x, z]) => [x, z])));
        }
      } else if (merged.geometry.type === "MultiPolygon") {
        merged.geometry.coordinates.forEach((polyCoords) => {
          if (polyCoords && polyCoords[0]) {
            addGeo(polyCoords.map((r) => r.map(([x, z]) => [x, z])));
          }
        });
      }
    });
  });
}

// Check if two rail segments should merge (touching on short sides)
function shouldMergeRailSegments(ring1, ring2) {
  if (!ring1 || !ring2 || ring1.length < 4 || ring2.length < 4) return false;

  const getBounds = (ring) => {
    const xs = ring.map(([x]) => x);
    const zs = ring.map(([, z]) => z);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minZ: Math.min(...zs),
      maxZ: Math.max(...zs),
    };
  };

  const b1 = getBounds(ring1);
  const b2 = getBounds(ring2);

  const w1 = b1.maxX - b1.minX;
  const l1 = b1.maxZ - b1.minZ;
  const w2 = b2.maxX - b2.minX;
  const l2 = b2.maxZ - b2.minZ;

  const isWidth1X = w1 < l1;
  const isWidth2X = w2 < l2;

  const tolerance = 0.2;

  if (isWidth1X === isWidth2X) {
    if (isWidth1X) {
      const touchOnZ =
        Math.abs(b1.maxZ - b2.minZ) < tolerance ||
        Math.abs(b2.maxZ - b1.minZ) < tolerance;
      const overlapX = b1.maxX > b2.minX && b1.minX < b2.maxX;

      return touchOnZ && overlapX;
    } else {
      const touchOnX =
        Math.abs(b1.maxX - b2.minX) < tolerance ||
        Math.abs(b2.maxX - b1.minX) < tolerance;
      const overlapZ = b1.maxZ > b2.minZ && b1.minZ < b2.maxZ;

      return touchOnX && overlapZ;
    }
  }

  return false;
}

// Add merged polygon to layer
function addMergedPolygonToLayer(ringArray, catConfig, layer) {
  const leafletPoly = createLeafletPolygonFromLocal(ringArray, catConfig);
  if (layer.addLayer) {
    layer.addLayer(leafletPoly);
  }
  return leafletPoly;
}
