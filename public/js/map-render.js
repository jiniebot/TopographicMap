// =============================================================================
// Rendering and Visual Effects
// Functions for stroke styling, zoom effects, and layer reordering
// =============================================================================

// ===== Zoom-Based Stroke Scaling =====
function calculateScaledStrokeWeight(baseWeight, currentZoom, minZoom = 2, maxZoom = 13) {
  // If called with just one parameter (legacy), use currentZoomLevel from global
  if (currentZoom === undefined) {
    currentZoom = typeof currentZoomLevel !== "undefined" ? currentZoomLevel : 7;
  }
  
  const logZoom = Math.log2(currentZoom - minZoom + 1);
  const logMaxZoom = Math.log2(maxZoom - minZoom + 1);
  const normalizedZoom = Math.max(0, Math.min(1, logZoom / logMaxZoom));

  const minWeight = Math.max(0.5, baseWeight * 0.3);
  const maxWeight = baseWeight * 3;

  return minWeight + (maxWeight - minWeight) * normalizedZoom;
}

function updateLayerStrokesOnZoom() {
  // Use global variables: map, categoryLayers, mapStyles
  if (typeof map === "undefined" || typeof categoryLayers === "undefined") {
    return; // Not ready yet
  }

  Object.entries(categoryLayers).forEach(([categoryName, layer]) => {
    if (!layer) return;
    const catConfig = mapStyles?.categories?.[categoryName];
    if (!catConfig) return;

    layer.eachLayer((polygon) => {
      const scaledWeight = calculateScaledStrokeWeight(catConfig.strokeWeight);
      polygon.setStyle({ weight: scaledWeight });
    });
  });
}

// ===== Layer Ordering =====
function reorderLayersOnMap(map, categoryLayers, config) {
  if (!config?.mapLayers || !Array.isArray(config.mapLayers)) {
    return;
  }

  const layerOrder = config.mapLayers;

  layerOrder.reverse().forEach((catName) => {
    if (categoryLayers[catName]) {
      categoryLayers[catName].bringToFront();
    }
  });
}

function reorderRoadLayers(map, categoryLayers, config) {
  const roadCategories = [
    "rail",
    "sidewalks",
    "paths",
    "mud_roads",
    "grav_roads",
    "misc_roads",
    "city_roads",
    "asf_roads",
  ];

  roadCategories.reverse().forEach((cat) => {
    if (categoryLayers[cat]) {
      categoryLayers[cat].bringToFront();
    }
  });

  const nonRoadFirst = ["rivers", "water", "grass"];
  nonRoadFirst.forEach((cat) => {
    if (categoryLayers[cat]) {
      categoryLayers[cat].bringToBack();
    }
  });
}
