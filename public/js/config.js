// DayZ Map Configuration
const config = {
    mapSize: 15360,
    tileSize: 256,
    tileMaxZoom: 9,
    darkMode: false,
    colors: {
        light: {
            waterBg: 'rgba(17, 57, 94, 1)',
            waterFill: 'rgba(24, 66, 105, 1)',
            waterStroke: 'rgb(50, 130, 200)',
            landFill: 'rgb(230, 225, 210)',
            landStroke: 'rgb(120, 110, 80)',
            controlBg: 'rgba(0, 0, 0, 0.85)',
            controlText: '#fff',
            toggleBtnBg: '#4CAF50',
            toggleBtnHover: '#45a049',
        },
        dark: {
            waterBg: 'rgb(20, 40, 70)',
            waterFill: 'rgb(40, 80, 120)',
            waterStroke: 'rgb(60, 120, 180)',
            landFill: 'rgb(60, 55, 45)',
            landStroke: 'rgb(100, 90, 60)',
            controlBg: 'rgba(255, 255, 255, 0.1)',
            controlText: '#e0e0e0ff',
            toggleBtnBg: '#1976D2',
            toggleBtnHover: '#1565C0',
        }
    }
};

const WORLD_SIZE = config.tileSize * Math.pow(2, config.tileMaxZoom);

// Area selection state
const areaSelection = {
    centerX: 7000,
    centerZ: 7000,
    size: 20000,
    rectangle: null,
};

// Layer references
let topoLayer = null;
let categoryLayers = {};
let powerLinesLayer = null;
let railsLayer = null;

// Map reference (initialized after DOM loads)
let map = null;

// Status display
let statusElement = null;
