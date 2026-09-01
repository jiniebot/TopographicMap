// =============================================================================
// Export Functions
// Functions for exporting map data in various formats (GeoJSON, SVG)
// =============================================================================

// ===== GeoJSON Export =====
function exportGeometriesAsGeoJSON(categoryLayers, categories = null) {
  const polygons = collectPolygonsByCategory(categoryLayers, categories);
  const features = [];

  Object.entries(polygons).forEach(([catName, polys]) => {
    polys.forEach((poly) => {
      features.push({
        type: "Feature",
        properties: { category: catName },
        geometry: poly.geometry,
      });
    });
  });

  const featureCollection = {
    type: "FeatureCollection",
    features: features,
  };

  return featureCollection;
}

// ===== SVG Export =====
function exportRoadsAsSVG(categoryLayers, svgWidth = 1024, svgHeight = 1024) {
  const roadsLayer = categoryLayers.asf_roads || categoryLayers.city_roads;

  if (!roadsLayer) {
    if (typeof setStatus === "function") {
      setStatus("No roads layer to export");
    }
    return null;
  }

  const bounds = map.getBounds();
  const padding = 0.01;

  const minLat = bounds.getSouth() - padding;
  const maxLat = bounds.getNorth() + padding;
  const minLng = bounds.getWest() - padding;
  const maxLng = bounds.getEast() + padding;

  let svg = `<svg width="${svgWidth}" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg">`;
  svg += `<rect width="${svgWidth}" height="${svgHeight}" fill="white"/>`;

  roadsLayer.eachLayer((layer) => {
    const latlngs = layer.getLatLngs();

    const projectLatLng = (latlng) => {
      const x =
        ((latlng.lng - minLng) / (maxLng - minLng)) * svgWidth;
      const y =
        ((maxLat - latlng.lat) / (maxLat - minLat)) *
        svgHeight;

      return [x, y];
    };

    const flattenRings = (rings) => {
      return rings.map((ring) => {
        if (ring.length && ring[0].length) {
          return ring;
        }
        return [ring];
      });
    };

    const allRings = Array.isArray(latlngs[0])
      ? flattenRings(latlngs)
      : [latlngs];

    allRings.forEach((ring) => {
      const points = ring
        .map((latlng) => projectLatLng(latlng))
        .map(([x, y]) => `${x},${y}`)
        .join(" ");

      svg += `<polygon points="${points}" fill="none" stroke="black" stroke-width="1"/>`;
    });
  });

  svg += "</svg>";

  return svg;
}

// ===== Export UI Initialization =====
function initializeExportButtons() {
  const exportBtn = document.getElementById("exportBtn");
  const exportSvgBtn = document.getElementById("exportSvgBtn");

  if (exportBtn) {
    exportBtn.addEventListener("click", () => {
      const geojson = exportGeometriesAsGeoJSON(categoryLayers);

      const dataStr = JSON.stringify(geojson, null, 2);
      const dataBlob = new Blob([dataStr], { type: "application/json" });
      const url = URL.createObjectURL(dataBlob);

      const link = document.createElement("a");
      link.href = url;
      link.download = "map-export.geojson";
      link.click();

      URL.revokeObjectURL(url);
      if (typeof setStatus === "function") {
        setStatus("GeoJSON exported");
      }
    });
  }

  if (exportSvgBtn) {
    exportSvgBtn.addEventListener("click", () => {
      const svg = exportRoadsAsSVG(categoryLayers);

      if (svg) {
        const blob = new Blob([svg], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");
        link.href = url;
        link.download = "roads-export.svg";
        link.click();

        URL.revokeObjectURL(url);
        if (typeof setStatus === "function") {
          setStatus("SVG exported");
        }
      }
    });
  }
}
