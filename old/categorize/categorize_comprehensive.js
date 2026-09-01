import fs from "fs";
import readline from "readline";
import path from "path";

// Create output directory
const outDir = "./data/TBData/categorized";
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Comprehensive category definitions with proper precedence
// Order matters: more specific categories should come first
const categories = {
  // NATURAL FEATURES - vegetation
  trees: {
    keywords: [
      "t_piceaabies",
      "t_fagussylvatica",
      "t_betulapendula",
      "t_quercusrobur",
      "t_larixdecidua",
      "t_pinussylvestris",
      "t_malusdomestica",
      "t_pyruscommunis",
      "t_prunusdomestica",
      "t_populusalba",
      "t_robiniapseudoacacia",
      "t_juglansregia",
      "t_fraxinusexcelsior",
      "t_sorbus",
      "t_carpinus",
      "t_populusnigra",
      "t_salixalba",
      "t_town",
      "t_naked",
      "tree",
    ],
    file: fs.createWriteStream(path.join(outDir, "trees_local_coords.csv")),
    count: 0,
  },
  bushes: {
    keywords: [
      "b_piceaabies",
      "b_betulahumilis",
      "b_prunusspinosa",
      "b_crataeguslaevigata",
      "b_corylusavellana",
      "b_sambucusnigra",
      "b_rosacanina",
      "b_fagussylvatica",
      "b_quercusrobur",
      "b_betulapendula",
      "b_naked",
      "bush",
      "shrub",
    ],
    file: fs.createWriteStream(path.join(outDir, "bushes_local_coords.csv")),
    count: 0,
  },
  plants: {
    keywords: [
      "p_articum",
      "p_phragmites",
      "p_heracleum",
      "p_helianthus",
      "p_urtica",
      "fern",
      "grass_patch",
      "moss_",
      "leaf_",
      "vaccinium",
      "anthoxanthum",
      "elytrigia",
      "viminibus",
      "smallpicea",
    ],
    file: fs.createWriteStream(path.join(outDir, "plants_local_coords.csv")),
    count: 0,
  },
  miscellaneous: {
    keywords: [
      "misc_",
      "canister",
      "helmet",
      "pilotka",
      "badminton",
      "bat",
      "cowboyhat",
      "motohelmet",
      "nabojnice",
      "ssh68",
      "sword",
      "megaphone",
      "teddybear",
      "cihly",
      "tribune",
      "sign_",
      "sign ",
      "busstop_city_sign",
    ],
    excludeKeywords: ["billboard", "crashbarrier"],
    file: fs.createWriteStream(
      path.join(outDir, "miscellaneous_local_coords.csv")
    ),
    count: 0,
  },
  grass: {
    keywords: [
      "grass_",
      "meadow",
      "c_concretegrass",
      "c_elytrigia",
      "c_lolium",
      "c_pines",
    ],
    file: fs.createWriteStream(path.join(outDir, "grass_local_coords.csv")),
    count: 0,
  },
  rocks: {
    keywords: [
      "rock_",
      "stone_",
      "stone",
      "boulder",
      "rubble_",
      "shellcrater",
      "stones_",
      "ruin_",
      "crater",
    ],
    file: fs.createWriteStream(path.join(outDir, "rocks_local_coords.csv")),
    count: 0,
  },
  debris: {
    keywords: [
      "debris",
      "dirtpile",
      "wreck",
      "l_plane",
      "l_long_pile",
      "l_large_pile",
      "d_piceaabies",
      "d_fagussylvatica",
      "d_quercusrobur",
      "d_pinussylvestris",
      "matress",
      "pillow",
      "blanket",
    ],
    file: fs.createWriteStream(path.join(outDir, "debris_local_coords.csv")),
    count: 0,
  },
  water: {
    keywords: ["pond_", "lake_", "river_", "stream", "water_"],
    file: fs.createWriteStream(path.join(outDir, "water_local_coords.csv")),
    count: 0,
  },
  cemetery: {
    keywords: ["cemetery_", "tomb", "grave", "dead_pile"],
    file: fs.createWriteStream(path.join(outDir, "cemetery_local_coords.csv")),
    count: 0,
  },

  // INFRASTRUCTURE & ROADS
  asf_roads: {
    keywords: ["asf"],
    excludeKeywords: [
      "city_stand_",
      "city_hospital",
      "city_policestation",
      "city_firestation",
      "city_store",
      "city_school",
      "rail_bridge",
    ],
    file: fs.createWriteStream(path.join(outDir, "asf_roads_local_coords.csv")),
    count: 0,
  },
  mud_roads: {
    keywords: ["mud"],
    excludeKeywords: [
      "city_stand_",
      "city_hospital",
      "city_policestation",
      "city_firestation",
      "city_store",
      "city_school",
      "rail_bridge",
    ],
    file: fs.createWriteStream(path.join(outDir, "mud_roads_local_coords.csv")),
    count: 0,
  },
  grav_roads: {
    keywords: ["grav"],
    excludeKeywords: [
      "city_stand_",
      "city_hospital",
      "city_policestation",
      "city_firestation",
      "city_store",
      "city_school",
      "rail_bridge",
    ],
    file: fs.createWriteStream(
      path.join(outDir, "grav_roads_local_coords.csv")
    ),
    count: 0,
  },
  city_roads: {
    keywords: ["city_"],
    excludeKeywords: [
      "city_stand_",
      "city_hospital",
      "city_policestation",
      "city_firestation",
      "city_store",
      "city_school",
      "rail_bridge",
    ],
    file: fs.createWriteStream(
      path.join(outDir, "city_roads_local_coords.csv")
    ),
    count: 0,
  },
  misc_roads: {
    keywords: ["road_", "bridge", "tunnel"],
    excludeKeywords: [
      "city_stand_",
      "city_hospital",
      "city_policestation",
      "city_firestation",
      "city_store",
      "city_school",
      "rail_bridge",
      "busstop_city_sign",
    ],
    file: fs.createWriteStream(
      path.join(outDir, "misc_roads_local_coords.csv")
    ),
    count: 0,
  },

  sidewalks: {
    keywords: ["sidewalk", "concrete_sidewalk", "platform", "pier_", "pier"],
    file: fs.createWriteStream(path.join(outDir, "sidewalks_local_coords.csv")),
    count: 0,
  },
  camp: {
    keywords: ["camp", "trailmap"],
    file: fs.createWriteStream(path.join(outDir, "camp_local_coords.csv")),
    count: 0,
  },
  paths: {
    keywords: ["path", "trail"],
    excludeKeywords: ["power_pole"],
    file: fs.createWriteStream(path.join(outDir, "paths_local_coords.csv")),
    count: 0,
  },
  rail: {
    keywords: [
      "rail",
      "railroad",
      "train_",
      "mine_rail",
      "track_",
      "wagon",
      "rail_bridge",
    ],
    excludeKeywords: [
      "pier_",
      "warehouse_",
      "train_",
      "lamp_",
      "pole_",
      "power_pole_",
      "rail_station",
      "rail_polet",
      "rail_signals",
      "rail_linebreak_concrete",
      "rail_linebreak_iron",
      "rail_crossing_block_10",
      "rail_crossing_barrier",
      "wall_",
      "platform_",
    ],
    file: fs.createWriteStream(path.join(outDir, "rail_local_coords.csv")),
    count: 0,
  },

  trains: {
    keywords: ["train_"],
    file: fs.createWriteStream(path.join(outDir, "trains_local_coords.csv")),
    count: 0,
  },

  // BUILDINGS & STRUCTURES
  industrial: {
    keywords: [
      "factory",
      "warehouse",
      "workshop",
      "mill",
      "plant",
      "cementworks",
      "coalplant",
      "mine_",
      "quarry_",
      "sawmill",
      "repair_",
      "shed_",
      "garage",
      "gasstation",
      "fuelstation",
      "smokestack",
      "construction",
      "welding",
      "sawhorse",
      "wheel",
      "workbench",
      "trolley",
      "pallettrolley",
    ],
    file: fs.createWriteStream(path.join(outDir, "workshops_local_coords.csv")),
    count: 0,
  },
  houses: {
    keywords: ["house", "apartment", "building", "mansion", "tenement"],
    excludeKeywords: ["houseboat", "guardhouse"],
    file: fs.createWriteStream(path.join(outDir, "houses_local_coords.csv")),
    count: 0,
  },
  farm: {
    keywords: ["farm", "hay", "barn", "silo", "stable"],
    file: fs.createWriteStream(path.join(outDir, "farm_local_coords.csv")),
    count: 0,
  },
  military: {
    keywords: [
      "airfield",
      "military",
      "hangar",
      "mil_",
      "barracks",
      "tisy_",
      "prison_",
      "tb_doors",
      "guardhouse",
      "taxiway",
      "centerline",
    ],
    file: fs.createWriteStream(path.join(outDir, "military_local_coords.csv")),
    count: 0,
  },

  // INFRASTRUCTURE DETAILS - moved before commercial to avoid keyword conflicts
  barriers: {
    keywords: [
      "barrier",
      "hbarrier",
      "roadblock",
      "fence",
      "crashbarrier",
      "rail_linebreak_concrete",
      "rail_linebreak_iron",
      "block_",
    ],
    file: fs.createWriteStream(path.join(outDir, "barriers_local_coords.csv")),
    count: 0,
  },
  decals: {
    keywords: ["decal_"],
    file: fs.createWriteStream(path.join(outDir, "decals_local_coords.csv")),
    count: 0,
  },
  panels: {
    keywords: ["panel_", "panels_"],
    file: fs.createWriteStream(path.join(outDir, "panels_local_coords.csv")),
    count: 0,
  },
  walls: {
    keywords: ["wall_", "wall ", "fen"],
    file: fs.createWriteStream(path.join(outDir, "walls_local_coords.csv")),
    count: 0,
  },
  billboards: {
    keywords: ["bilboard", "billboard"],
    file: fs.createWriteStream(
      path.join(outDir, "billboards_local_coords.csv")
    ),
    count: 0,
  },
  lamps: {
    keywords: [
      "lamp_",
      "lamp ",
      "light_",
      "power_pole_",
      "rail_polet",
      "rail_signals",
    ],
    file: fs.createWriteStream(path.join(outDir, "lamps_local_coords.csv")),
    count: 0,
  },
  tanks: {
    keywords: ["tank_", "tank "],
    file: fs.createWriteStream(path.join(outDir, "tanks_local_coords.csv")),
    count: 0,
  },
  containers: {
    keywords: ["container_"],
    file: fs.createWriteStream(
      path.join(outDir, "containers_local_coords.csv")
    ),
    count: 0,
  },
  pipes: {
    keywords: ["pipe_"],
    file: fs.createWriteStream(path.join(outDir, "pipes_local_coords.csv")),
    count: 0,
  },

  commercial: {
    keywords: [
      "shop",
      "store",
      "market",
      "office",
      "bank",
      "hotel",
      "restaurant",
      "pub",
      "cafe",
      "police",
      "fire",
      "grocery",
      "fastfood",
      "city_stand_",
      "city_hospital",
      "city_policestation",
      "city_firestation",
      "city_store",
      "city_school",
      "rail_station",
    ],
    file: fs.createWriteStream(
      path.join(outDir, "commercial_local_coords.csv")
    ),
    count: 0,
  },
  entertainment: {
    keywords: [
      "lunapark",
      "carousel",
      "ferris",
      "autodrome",
      "skilift",
      "ski",
      "busstop",
      "busstation",
      "chapel",
      "church",
      "monument",
      "monument_",
      "statue",
      "castle",
      "swan",
      "cableway",
      "skilift_rope",
      "radio_panelbig",
    ],
    file: fs.createWriteStream(
      path.join(outDir, "entertainment_local_coords.csv")
    ),
    count: 0,
  },
  power: {
    keywords: [
      "power_",
      "hv_",
      "power",
      "electric",
      "cable",
      "decon_",
      "tower_tc",
      "radio_",
    ],
    file: fs.createWriteStream(path.join(outDir, "power_local_coords.csv")),
    count: 0,
  },

  // MATERIALS & DEBRIS
  garbage: {
    keywords: ["garbage_"],
    file: fs.createWriteStream(path.join(outDir, "garbage_local_coords.csv")),
    count: 0,
  },
  marine: {
    keywords: ["boat", "ship_", "dam", "dock", "marina"],
    file: fs.createWriteStream(path.join(outDir, "marine_local_coords.csv")),
    count: 0,
  },
  medical: {
    keywords: [
      "medical",
      "stretcher",
      "hospital",
      "healthcare",
      "patient_monitor",
    ],
    file: fs.createWriteStream(path.join(outDir, "medical_local_coords.csv")),
    count: 0,
  },
};

let lineCount = 0;
let categorized = 0;
let uncategorized = [];

// Process both circles and rectangles
const sourceFiles = [
  "./data/TBData/source/circles_local_coords.csv",
  "./data/TBData/source/rectangles_local_coords.csv",
];

let currentFile = 0;

function processFile(filePath) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    let headerWritten = lineCount > 0; // Only write header for first file

    rl.on("line", (line) => {
      if (lineCount === 0 && !headerWritten) {
        // Write header to all category files
        Object.values(categories).forEach((cat) => {
          cat.file.write(line + "\n");
        });
        headerWritten = true;
        lineCount++;
        return;
      }

      if (lineCount === 0) {
        lineCount++;
        return;
      }

      // Extract object name (first quoted field)
      const match = line.match(/^"([^"]+)"/);
      if (match) {
        const objectName = match[1].toLowerCase();

        // Try to categorize the object (first match wins due to precedence order)
        let found = false;
        for (const [catName, catData] of Object.entries(categories)) {
          // Check if any keyword matches
          const keywordMatches = catData.keywords.some((kw) =>
            objectName.includes(kw)
          );
          if (!keywordMatches) continue;

          // Check if any exclude keyword matches (if they exist)
          if (
            catData.excludeKeywords &&
            catData.excludeKeywords.some((kw) => objectName.includes(kw))
          ) {
            continue; // Skip this category due to exclusion
          }

          // All checks passed, categorize it
          catData.file.write(line + "\n");
          catData.count++;
          categorized++;
          found = true;
          break;
        }

        if (!found) {
          uncategorized.push({ name: match[1], line: line });
        }
      }

      lineCount++;
    });

    rl.on("close", () => {
      resolve();
    });
  });
}

async function main() {
  // Process all source files
  for (const file of sourceFiles) {
    await processFile(file);
  }

  // Close all streams
  Object.values(categories).forEach((cat) => cat.file.end());

  console.log(`✓ Comprehensive object categorization complete!\n`);
  console.log(`  Total lines processed: ${lineCount}`);
  console.log(`  Total categorized: ${categorized}`);
  console.log(`  Uncategorized: ${uncategorized.length}\n`);
  console.log(
    `Category breakdown (${Object.keys(categories).length} categories):\n`
  );

  const sorted = Object.entries(categories).sort(
    (a, b) => b[1].count - a[1].count
  );

  let totalCount = 0;
  sorted.forEach(([name, data]) => {
    totalCount += data.count;
    const pct = ((data.count / (lineCount - 1)) * 100).toFixed(2);
    if (data.count > 0) {
      console.log(
        `  ${name.padEnd(20)}: ${data.count
          .toString()
          .padStart(8)} objects (${pct}%)`
      );
    }
  });

  const coveragePct = ((categorized / (lineCount - 1)) * 100).toFixed(2);
  console.log(
    `\n  TOTAL CATEGORIZED: ${categorized} / ${lineCount - 1} (${coveragePct}%)`
  );

  if (uncategorized.length > 0) {
    console.log(`\n⚠ ${uncategorized.length} uncategorized objects found!`);

    // Save uncategorized objects
    const uncatFile = path.join(outDir, "uncategorized_local_coords.csv");
    const header = "x,y,z\n"; // Default header
    const uncatContent = uncategorized.map((obj) => obj.line).join("\n");
    fs.writeFileSync(uncatFile, header + uncatContent);

    console.log(`  Saved to: ${uncatFile}`);
    console.log(`\n  Sample uncategorized objects (first 10):`);
    uncategorized.slice(0, 10).forEach((obj) => {
      console.log(`    - ${obj.name}`);
    });

    if (uncategorized.length > 10) {
      console.log(`    ... and ${uncategorized.length - 10} more`);
    }
  }

  console.log(`\n✓ All files written to ${outDir}/`);
}

main().catch(console.error);
