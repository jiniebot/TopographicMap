// =============================================================================
// Utility Functions and Helpers
// General utility functions used across the application
// =============================================================================

// Stub definitions for functions that will be defined in map-core.js
// These allow utilities to be used before core loads
if (typeof setStatus === "undefined") {
  window.setStatus = function(message, type = "normal") {
    console.log(`[STATUS] ${type.toUpperCase()}: ${message}`);
  };
}

if (typeof displayTopographic === "undefined") {
  window.displayTopographic = function(geojson) {
    console.log("[STUB] displayTopographic called before core.js loaded");
  };
}

// ===== Contour Visualization =====
function clearContours() {
  if (window.contourLayer) {
    map.removeLayer(window.contourLayer);
    window.contourLayer = null;
  }
  if (typeof setStatus === "function") {
    setStatus("Contours cleared");
  }
}

// ===== GeoJSON Loading =====
function loadGeoJSON(url, styleFunc, onEachFunc) {
  return fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((geojson) => {
      // If style and onEach functions are provided, create a Leaflet layer
      if (styleFunc || onEachFunc) {
        return L.geoJSON(geojson, {
          style: styleFunc,
          onEachFeature: onEachFunc,
        });
      }
      // Otherwise return the raw GeoJSON data
      return geojson;
    })
    .catch((err) => {
      console.error("GeoJSON load error:", err);
      if (typeof setStatus === "function") {
        setStatus("Error loading GeoJSON");
      }
      throw err;
    });
}

// ===== Polygon Collection =====
function collectPolygonsByCategory(categoryLayers, categories = null) {
  const polygons = {};

  const cats = categories || Object.keys(categoryLayers);

  cats.forEach((catName) => {
    if (!categoryLayers[catName]) return;

    polygons[catName] = [];

    categoryLayers[catName].eachLayer((layer) => {
      if (layer.toGeoJSON) {
        polygons[catName].push(layer.toGeoJSON());
      }
    });
  });

  return polygons;
}
