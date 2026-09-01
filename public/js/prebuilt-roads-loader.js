// Loader for prebuilt geometry GeoJSON (optional fast path).
// Handles roads, sidewalks, rails, paths, walls, and other categories
// Exposes window.loadPrebuiltCategory and window.addPrebuiltCategory

(function () {
  let prebuiltData = {}; // Object to store per-category data
  let prebuiltTried = {}; // Track which categories we've already tried to load

  async function loadPrebuiltCategory(categoryName) {
    if (prebuiltData[categoryName]) return prebuiltData[categoryName];
    if (prebuiltTried[categoryName]) return null;
    
    prebuiltTried[categoryName] = true;
    
    try {
      const resp = await fetch(`./out/prebuilt/${categoryName}-prebuilt.geojson`);
      if (!resp.ok) return null;
      const data = await resp.json();
      prebuiltData[categoryName] = data;
      console.log(`[Prebuilt] Loaded ${categoryName}: ${data.features?.length || 0} features`);
      return data;
    } catch (e) {
      console.warn(`[Prebuilt] Failed to load ${categoryName}`, e);
    }
    return null;
  }

  function addPrebuiltCategory(layer, catConfig, categoryName) {
    const data = prebuiltData[categoryName];
    if (!data) return 0;
    if (!data.features) return 0;
    
    let added = 0;

    data.features.forEach((feat) => {
      const props = feat.properties || {};
      const geom = feat.geometry;
      if (!geom || !geom.coordinates) return;

      // Only add features for this category
      if (props.category !== categoryName) return;

      const addOne = (rings) => {
        if (!rings || !rings.length) return;
        let opts = {};
        if (props.strokeOpacity === 0) {
          opts = { strokeOpacityOverride: 0 };
        }
        const leafletPoly = createLeafletPolygonFromLocal(rings, catConfig, opts);
        leafletPoly._objectName = props.objectName || `${categoryName}_prebuilt`;
        leafletPoly._category = categoryName;
        leafletPoly._localRings = rings;
        if ((catConfig.popupEnabled ?? mapStyles?.popupEnabled) === true) {
          leafletPoly.bindPopup(
            `<strong>${leafletPoly._objectName}</strong><br/>Category: ${catConfig.label}`
          );
        }
        layer.addLayer(leafletPoly);
        added += 1;
      };

      if (geom.type === "Polygon") {
        const rings = geom.coordinates.map((r) => r.map(([x, z]) => [x, z]));
        addOne(rings);
      } else if (geom.type === "MultiPolygon") {
        geom.coordinates.forEach((poly) => {
          const rings = poly.map((r) => r.map(([x, z]) => [x, z]));
          addOne(rings);
        });
      }
    });

    return added;
  }

  if (typeof window !== "undefined") {
    window.loadPrebuiltCategory = loadPrebuiltCategory;
    window.addPrebuiltCategory = addPrebuiltCategory;
    // Keep old names for backwards compatibility
    window.loadPrebuiltRoadsForCategory = loadPrebuiltCategory;
    window.addPrebuiltRoadCategory = addPrebuiltCategory;
  }
})();
