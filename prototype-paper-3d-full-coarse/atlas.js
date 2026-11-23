(() => {
  "use strict";

  const ATLAS_SIZE = 1024;
  const PAD = 3;

  // Exact palette sampled from prototype-paper/assets/map.jpg & map-top.png
  const PX = {
    riverBase: "#6ec4b4",
    riverLight: "#86d5c7",
    riverDark: "#5ab1a1",
    promenade: "#d4cec6",
    promenadeLine: "#bcb5ab",
    plazaA: "#eed7c0",
    plazaB: "#e4c8ad",
    plazaSeam: "#d3b599",
    roofMid: "#6f7b86",
    roofLight: "#88949f",
    roofDark: "#58636e",
    roofRidge: "#ebe3d5",
    wallCream: "#f6ebd4",
    wallCreamShade: "#e3d3b5",
    wallPink: "#ebc0b7",
    wallPinkShade: "#d5a399",
    wallMint: "#cfe0cc",
    wallMintShade: "#b4c9b2",
    wallOchre: "#f2dba9",
    wallOchreShade: "#dabe89",
    brickWarm: "#ded3c2",
    brickShade: "#c3b7a5",
    archDark: "#5c4a40",
    archMid: "#786254",
    trimLight: "#fff6e5",
    trimWarm: "#c9ad8c",
    glassTeal: "#4d988c",
    glassAmber: "#e0ab4e",
    glassBlue: "#527ba6",
    lanternRed: "#d9462b",
    lanternGlow: "#f5b851",
    leafLight: "#98c867",
    leafMid: "#6fa94e",
    leafDark: "#4e833b",
    leafDeep: "#365e2d",
    trunk: "#6d4e3b",
    trunkDark: "#4e3628",
    steel: "#7a92a1",
    steelLight: "#a1b7c4",
    steelDark: "#536978",
    wood: "#9e683e",
    woodDark: "#704628",
    canopy: "#ebd09c",
    stoneLight: "#ece6dc",
    stoneMid: "#d3cdc3",
    stoneDark: "#9e988e"
  };

  // Clean non-overlapping 1024x1024 atlas slots (x, y, w, h)
  const SLOTS = {
    river:         [4,   4,   180, 180],
    roofTile:      [196, 4,   160, 120],
    plazaTile:     [368, 4,   128, 128],
    promenade:     [508, 4,   116, 128],
    embankment:    [636, 4,   120, 64],
    stoneStep:     [636, 76,  120, 64],
    parkingPad:    [768, 4,   120, 136],
    woodBoat:      [896, 4,   120, 64],
    umbrella:      [896, 76,  120, 64],

    // Direct hero facade crops from map.jpg
    haiguanFront:  [4,   196, 256, 112],
    haiguanTower:  [272, 196, 96,  112],
    qimingliGate:  [380, 196, 112, 112],
    museumFront:   [504, 196, 224, 128],
    pengjiangSide: [740, 196, 276, 64],
    ironTruss:     [740, 268, 276, 64],

    // Crisp pixel-art modular architectural facades (4px art-texel grid)
    qilouCream:    [4,   336, 128, 144],
    qilouPink:     [144, 336, 128, 144],
    qilouMint:     [284, 336, 128, 144],
    qilouOchre:    [424, 336, 128, 144],
    qilouLantern:  [564, 336, 128, 144],
    lingnanWall:   [704, 336, 128, 128],
    xinshiBridge:  [844, 336, 168, 96],

    // Volumetric pixel foliage & alpha-cutout trees/props
    banyanTop:     [4,   496, 184, 184],
    banyanSide:    [200, 496, 200, 168],
    treeLeaf:      [412, 496, 128, 128],
    treeCluster:   [552, 496, 128, 128],
    stallCream:    [692, 496, 96,  96],
    stallGreen:    [800, 496, 96,  96],
    gableMask:     [908, 496, 108, 64],

    // Clean solid-ish pixel accents (cars, ridge, pedestrians, roof gables)
    carWhite:      [4,   696, 96,  64],
    carBlue:       [112, 696, 96,  64],
    carYellow:     [220, 696, 96,  64],
    ridgeCap:      [328, 696, 96,  48],
    parapetTop:    [436, 696, 96,  48],
    pedestrianA:   [544, 696, 48,  64],
    pedestrianB:   [604, 696, 48,  64],
    pedestrianC:   [664, 696, 48,  64],
    sampleRidge:   [724, 696, 96,  48],
    sampleParapet: [832, 696, 96,  48],

    sampleRoofTile:   [4,   772, 160, 112],
    sampleGableCream: [176, 772, 128, 112],
    sampleGablePink:  [316, 772, 128, 112],
    sampleGableOchre: [456, 772, 128, 112],
    sampleGableMint:  [596, 772, 128, 112],
    sampleGableWave:  [736, 772, 128, 112],
    sampleSkybridge:  [876, 772, 140, 112],
    sampleUpperCream: [4,   896, 128, 120],
    sampleUpperPink:  [144, 896, 128, 120],
    sampleUpperOchre: [284, 896, 128, 120],
    sampleUpperMint:  [424, 896, 128, 120],
    sampleUpperCoral: [564, 896, 128, 120],
    sampleArcadeArch: [704, 896, 96,  120],
    sampleSideGrey:   [812, 896, 72,  120],
    sampleLantern:    [896, 896, 56,  56],
    sampleCavity:     [896, 960, 56,  56],
    sampleMintSide:   [960, 896, 56,  56],
    samplePinkSide:   [960, 960, 56,  56],

    // Dedicated solid voxel light/shade swatches for coarse 4-shop tiers (unused atlas strip y=604..671)
    vxTrimTop:        [696, 604, 16, 16],
    vxTrimFront:      [720, 604, 16, 16],
    vxTrimShade:      [744, 604, 16, 16],
    vxTrimUnder:      [768, 604, 16, 16],
    vxCreamMid:       [792, 604, 16, 16],
    vxCreamShade:     [816, 604, 16, 16],
    vxCreamDark:      [840, 604, 16, 16],
    vxPinkMid:        [864, 604, 16, 16],
    vxPinkShade:      [888, 604, 16, 16],
    vxPinkDark:       [912, 604, 16, 16],
    vxOchreMid:       [936, 604, 16, 16],
    vxOchreShade:     [960, 604, 16, 16],
    vxOchreDark:      [984, 604, 16, 16],

    vxMintMid:        [696, 628, 16, 16],
    vxMintShade:      [720, 628, 16, 16],
    vxMintDark:       [744, 628, 16, 16],
    vxGreyLight:      [768, 628, 16, 16],
    vxGreyMid:        [792, 628, 16, 16],
    vxGreyShade:      [816, 628, 16, 16],
    vxWinDark:        [840, 628, 16, 16],
    vxGlassTeal:      [864, 628, 16, 16],
    vxGlassTealDark:  [888, 628, 16, 16],
    vxGlassAmber:     [912, 628, 16, 16],
    vxGlassBlueDark:  [936, 628, 16, 16],
    vxCavityDeep:     [960, 628, 16, 16],
    vxCavityMid:      [984, 628, 16, 16],

    vxCavityDoor:     [696, 652, 16, 16],
    vxRoofLight:      [720, 652, 16, 16],
    vxRoofMid:        [744, 652, 16, 16],
    vxRoofDark:       [768, 652, 16, 16],
    vxRidgeTop:       [792, 652, 16, 16],
    vxRidgeSide:      [816, 652, 16, 16],
    vxLanternGold:    [840, 652, 16, 16],
    vxLanternOrange:  [864, 652, 16, 16],
    vxLanternRed:     [888, 652, 16, 16],
    vxLanternDeep:    [912, 652, 16, 16],
    vxWoodDark:       [936, 652, 16, 16],
    vxWoodMid:        [960, 652, 16, 16],
    vxWoodLight:      [984, 652, 16, 16],

    vxStoneTop:       [412, 632, 16, 16],
    vxStoneLight:     [436, 632, 16, 16],
    vxStoneMid:       [460, 632, 16, 16],
    vxStoneShade:     [484, 632, 16, 16],
    vxStoneDark:      [508, 632, 16, 16],
    vxSteelLight:     [532, 632, 16, 16],
    vxSteelMid:       [556, 632, 16, 16],
    vxSteelDark:      [580, 632, 16, 16],
    vxLeafLight:      [604, 632, 16, 16],
    vxLeafMid:        [628, 632, 16, 16],
    vxLeafDark:       [652, 632, 16, 16],

    vxLeafDeep:       [412, 656, 16, 16],
    vxTrunkMid:       [436, 656, 16, 16],
    vxTrunkDark:      [460, 656, 16, 16],
    vxBrickLight:     [484, 656, 16, 16],
    vxBrickMid:       [508, 656, 16, 16],
    vxBrickShade:     [532, 656, 16, 16],
    vxBrickDark:      [556, 656, 16, 16],
    vxCanopyLight:    [580, 656, 16, 16],
    vxCanopyShade:    [604, 656, 16, 16],
    vxGreenAwning:    [628, 656, 16, 16],
    vxGreenAwningDark:[652, 656, 16, 16],

    vxCarWhite:       [912, 572, 16, 16],
    vxCarBlue:        [936, 572, 16, 16],
    vxCarYellow:      [960, 572, 16, 16],
    vxClockFace:      [984, 572, 16, 16],

    vxClockHand:      [940, 700, 16, 16],
    vxWaterFoam:      [964, 700, 16, 16],
    vxWaterEdge:      [988, 700, 16, 16],
    vxParkingPad:     [940, 724, 16, 16],
    vxParkingLine:    [964, 724, 16, 16],
    vxPedShirtA:      [988, 724, 16, 16],
    vxPedShirtB:      [940, 748, 16, 16],
    vxPedShirtC:      [964, 748, 16, 16],
    vxPedSkin:        [988, 748, 16, 16]
  };

  function getUvRect(name) {
    const [x, y, w, h] = SLOTS[name];
    // Inset by 0.5px to prevent border bleeding under sharp bilinear filtering
    return [
      (x + 0.5) / ATLAS_SIZE,
      (y + 0.5) / ATLAS_SIZE,
      (w - 1.0) / ATLAS_SIZE,
      (h - 1.0) / ATLAS_SIZE,
      w,
      h
    ];
  }

  function pxRect(ctx, ox, oy, gx, gy, gw, gh, color, unit = 4) {
    ctx.fillStyle = color;
    ctx.fillRect(ox + gx * unit, oy + gy * unit, gw * unit, gh * unit);
  }

  // Bleed 2px border around slot to keep mipmap/bilinear clean
  function bleedSlot(ctx, x, y, w, h) {
    for (let step = 1; step <= PAD; step += 1) {
      ctx.drawImage(ctx.canvas, x, y, w, 1, x, y - step, w, 1);
      ctx.drawImage(ctx.canvas, x, y + h - 1, w, 1, x, y + h - 1 + step, w, 1);
      ctx.drawImage(ctx.canvas, x, y, 1, h, x - step, y, 1, h);
      ctx.drawImage(ctx.canvas, x + w - 1, y, 1, h, x + w - 1 + step, y, 1, h);
    }
  }

  // Draw a crisp modular Sino-Western Qilou facade at 4px art-pixel grid
  function drawQilouTile(ctx, slot, wallColor, shadeColor, opts = {}) {
    const [ox, oy, w, h] = slot;
    const u = 4;
    const cols = w / u; // 32
    const rows = h / u; // 36
    ctx.clearRect(ox, oy, w, h);

    // Scalloped Baroque parapet gable top (rows 0..6) with alpha cutout corners
    // Base rectangular body starts at row 6
    pxRect(ctx, ox, oy, 0, 6, cols, rows - 6, wallColor, u);
    // Subtle vertical plaster joints & shading on edges
    pxRect(ctx, ox, oy, 0, 6, 1, rows - 6, shadeColor, u);
    pxRect(ctx, ox, oy, cols - 1, 6, 1, rows - 6, shadeColor, u);
    pxRect(ctx, ox, oy, 15, 6, 2, rows - 6, shadeColor, u);

    // Ornate curved/stepped relief gable (rows 1..6)
    pxRect(ctx, ox, oy, 1, 5, cols - 2, 1, PX.trimLight, u);
    pxRect(ctx, ox, oy, 3, 4, cols - 6, 1, wallColor, u);
    pxRect(ctx, ox, oy, 6, 3, cols - 12, 1, wallColor, u);
    pxRect(ctx, ox, oy, 10, 2, cols - 20, 1, wallColor, u);
    pxRect(ctx, ox, oy, 13, 1, 6, 1, PX.trimLight, u);
    // Gable border highlight & relief medallion
    pxRect(ctx, ox, oy, 3, 4, 2, 1, PX.trimLight, u);
    pxRect(ctx, ox, oy, cols - 5, 4, 2, 1, PX.trimLight, u);
    pxRect(ctx, ox, oy, 6, 3, 2, 1, PX.trimLight, u);
    pxRect(ctx, ox, oy, cols - 8, 3, 2, 1, PX.trimLight, u);
    pxRect(ctx, ox, oy, 10, 2, 2, 1, PX.trimLight, u);
    pxRect(ctx, ox, oy, cols - 12, 2, 2, 1, PX.trimLight, u);
    // Medallion ring in center of gable
    pxRect(ctx, ox, oy, 14, 3, 4, 3, shadeColor, u);
    pxRect(ctx, ox, oy, 15, 4, 2, 1, PX.trimLight, u);

    // Horizontal cornice bands
    pxRect(ctx, ox, oy, 0, 7, cols, 1, PX.trimLight, u);
    pxRect(ctx, ox, oy, 0, 8, cols, 1, shadeColor, u);
    pxRect(ctx, ox, oy, 0, 20, cols, 1, PX.trimLight, u);
    pxRect(ctx, ox, oy, 0, 21, cols, 1, shadeColor, u);

    // Second floor Manchu stained-glass windows (4 tall arched bays)
    const winXs = [3, 10, 18, 25];
    const glasses = [PX.glassTeal, PX.glassAmber, PX.glassBlue, PX.glassTeal];
    winXs.forEach((wx, idx) => {
      // Outer window casing
      pxRect(ctx, ox, oy, wx - 1, 10, 6, 9, shadeColor, u);
      pxRect(ctx, ox, oy, wx, 11, 4, 7, PX.archDark, u);
      // Colored Manchu glass panes (2x2 grid)
      pxRect(ctx, ox, oy, wx, 11, 2, 3, glasses[idx], u);
      pxRect(ctx, ox, oy, wx + 2, 11, 2, 3, PX.glassAmber, u);
      pxRect(ctx, ox, oy, wx, 15, 2, 3, PX.glassBlue, u);
      pxRect(ctx, ox, oy, wx + 2, 15, 2, 3, glasses[(idx + 1) % 4], u);
      // Horizontal & vertical mullion bar
      pxRect(ctx, ox, oy, wx, 14, 4, 1, PX.trimLight, u);
      pxRect(ctx, ox, oy, wx + 1, 11, 1, 7, PX.archMid, u);
      // Window sill
      pxRect(ctx, ox, oy, wx - 1, 19, 6, 1, PX.trimLight, u);
    });

    // Ground floor Roman arched colonnade (rows 22..35)
    const archXs = [2, 12, 22];
    for (const ax of archXs) {
      // Deep shadowed arcade interior
      pxRect(ctx, ox, oy, ax + 1, 23, 6, 1, PX.archDark, u);
      pxRect(ctx, ox, oy, ax, 24, 8, 12, PX.archDark, u);
      // Inner wooden shopfront hint inside arcade shadow
      pxRect(ctx, ox, oy, ax + 2, 28, 4, 8, PX.archMid, u);
      pxRect(ctx, ox, oy, ax + 3, 30, 2, 5, PX.trimWarm, u);
      // Arch voussoir highlight
      pxRect(ctx, ox, oy, ax + 1, 22, 6, 1, PX.trimLight, u);
      if (opts.lanterns) {
        pxRect(ctx, ox, oy, ax + 3, 24, 2, 1, PX.archMid, u);
        pxRect(ctx, ox, oy, ax + 3, 25, 2, 3, PX.lanternRed, u);
        pxRect(ctx, ox, oy, ax + 3, 26, 1, 1, PX.lanternGlow, u);
      }
    }
    // Pillar bases
    for (const px of [0, 10, 20, 30]) {
      pxRect(ctx, ox, oy, px, 34, 2, 2, shadeColor, u);
    }
  }

  function drawLingnanWall(ctx, slot) {
    const [ox, oy, w, h] = slot;
    const u = 4;
    const cols = w / u;
    const rows = h / u;
    pxRect(ctx, ox, oy, 0, 0, cols, rows, PX.brickWarm, u);
    // Subtle horizontal brick/plaster texture
    for (let r = 0; r < rows; r += 2) {
      for (let c = (r % 4 === 0 ? 0 : 2); c < cols; c += 4) {
        pxRect(ctx, ox, oy, c, r, 2, 1, PX.brickShade, u);
      }
    }
    // Eave shadow band & cornice
    pxRect(ctx, ox, oy, 0, 0, cols, 2, PX.roofDark, u);
    pxRect(ctx, ox, oy, 0, 2, cols, 1, PX.trimLight, u);
    // Upper timber lattice windows
    for (const wx of [5, 14, 23]) {
      pxRect(ctx, ox, oy, wx, 7, 4, 6, PX.archDark, u);
      pxRect(ctx, ox, oy, wx + 1, 8, 2, 4, PX.archMid, u);
      pxRect(ctx, ox, oy, wx, 13, 4, 1, PX.trimLight, u);
    }
    // Ground wooden shop doors & stone plinth
    pxRect(ctx, ox, oy, 0, 28, cols, 4, PX.stoneMid, u);
    pxRect(ctx, ox, oy, 11, 19, 10, 13, PX.archDark, u);
    pxRect(ctx, ox, oy, 12, 20, 4, 12, PX.wood, u);
    pxRect(ctx, ox, oy, 16, 20, 4, 12, PX.woodDark, u);
  }

  function drawSampleSegmentTiles(ctx) {
    {
      const [ox, oy, w, h] = SLOTS.sampleRoofTile;
      ctx.fillStyle = "#687684";
      ctx.fillRect(ox, oy, w, h);
      const cols = 5;
      const bandW = w / cols;
      for (let colIdx = 0; colIdx < cols; colIdx += 1) {
        const bx = ox + colIdx * bandW;
        ctx.fillStyle = "#5e6b79";
        ctx.fillRect(bx, oy, 6, h);
        ctx.fillStyle = "#697785";
        ctx.fillRect(bx + 6, oy, 8, h);
        ctx.fillStyle = "#748391";
        ctx.fillRect(bx + 14, oy, 10, h);
        ctx.fillStyle = "#667482";
        ctx.fillRect(bx + 24, oy, 8, h);
      }
      const rows = 4;
      const rowH = h / rows;
      for (let rowIdx = 0; rowIdx < rows; rowIdx += 1) {
        const ry = oy + rowIdx * rowH;
        ctx.fillStyle = "rgba(44,52,62,0.12)";
        ctx.fillRect(ox, ry + rowH - 4, w, 4);
        for (let colIdx = 0; colIdx < cols; colIdx += 1) {
          if ((colIdx + rowIdx) % 3 === 0) {
            ctx.fillStyle = "rgba(44,52,62,0.06)";
            ctx.fillRect(ox + colIdx * bandW + 6, ry + 3, 18, rowH - 8);
          } else if ((colIdx + rowIdx * 2) % 4 === 1) {
            ctx.fillStyle = "rgba(198,210,222,0.06)";
            ctx.fillRect(ox + colIdx * bandW + 8, ry + 3, 16, rowH - 8);
          }
        }
      }
      bleedSlot(ctx, ox, oy, w, h);
    }

    {
      const [ox, oy, w, h] = SLOTS.sampleRidge;
      ctx.fillStyle = "#c8c0b3";
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = "#d5cec2";
      ctx.fillRect(ox, oy, w, Math.floor(h * 0.45));
      ctx.fillStyle = "#b7afa2";
      ctx.fillRect(ox, oy + Math.floor(h * 0.78), w, h - Math.floor(h * 0.78));
      bleedSlot(ctx, ox, oy, w, h);
    }

    {
      const [ox, oy, w, h] = SLOTS.sampleParapet;
      ctx.fillStyle = "#dfd7ca";
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = "#ebe4d8";
      ctx.fillRect(ox, oy, w, Math.floor(h * 0.42));
      ctx.fillStyle = "#ccc3b5";
      ctx.fillRect(ox, oy + Math.floor(h * 0.8), w, h - Math.floor(h * 0.8));
      bleedSlot(ctx, ox, oy, w, h);
    }

    const drawGable = (slot, wallCol, shadeCol, style) => {
      const [ox, oy, w, h] = slot;
      const unit = 4;
      const cols = w / unit;
      const rows = h / unit;
      ctx.clearRect(ox, oy, w, h);
      const fillRowSpan = (row, left, right, col) => {
        pxRect(ctx, ox, oy, left, row, right - left, 1, col, unit);
      };
      const drawTrimEdge = (row, left, right, trim = PX.trimLight) => {
        pxRect(ctx, ox, oy, left, row, 2, 1, trim, unit);
        pxRect(ctx, ox, oy, right - 2, row, 2, 1, trim, unit);
      };

      if (style === "serratedCream" || style === "serratedPink" || style === "serratedOchre") {
        const topRow = style === "serratedOchre" ? 2 : 3;
        pxRect(ctx, ox, oy, 0, rows - 5, cols, 5, wallCol, unit);
        pxRect(ctx, ox, oy, 0, rows - 5, cols, 2, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 0, rows - 3, cols, 1, shadeCol, unit);
        pxRect(ctx, ox, oy, 0, rows - 12, 3, 7, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 1, rows - 11, 1, 6, wallCol, unit);
        pxRect(ctx, ox, oy, cols - 3, rows - 12, 3, 7, PX.trimLight, unit);
        pxRect(ctx, ox, oy, cols - 2, rows - 11, 1, 6, wallCol, unit);
        const profile = [
          [rows - 6, 1, 31], [rows - 7, 1, 31], [rows - 8, 2, 30], [rows - 9, 2, 30],
          [rows - 10, 4, 28], [rows - 11, 4, 28], [rows - 12, 6, 26], [rows - 13, 6, 26],
          [rows - 14, 7, 25], [rows - 15, 7, 25], [rows - 16, 8, 24], [rows - 17, 9, 23],
          [rows - 18, 9, 23], [rows - 19, 10, 22], [rows - 20, 11, 21], [rows - 21, 11, 21],
          [rows - 22, 12, 20], [rows - 23, 13, 19], [rows - 24, 14, 18]
        ];
        for (const [rowIdx, left, right] of profile) {
          if (rowIdx < topRow) continue;
          fillRowSpan(rowIdx, left, right, wallCol);
          drawTrimEdge(rowIdx, left, right, PX.trimLight);
        }
        pxRect(ctx, ox, oy, 13, topRow, 6, 2, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 14, topRow - 1, 4, 1, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 8, rows - 11, 16, 1, shadeCol, unit);
        pxRect(ctx, ox, oy, 10, rows - 15, 12, 1, shadeCol, unit);
        if (style === "serratedOchre") {
          pxRect(ctx, ox, oy, 13, rows - 17, 6, 6, shadeCol, unit);
          pxRect(ctx, ox, oy, 14, rows - 16, 4, 4, PX.trimLight, unit);
          pxRect(ctx, ox, oy, 15, rows - 15, 2, 2, PX.archMid, unit);
        } else {
          pxRect(ctx, ox, oy, 13, rows - 16, 6, 6, PX.trimLight, unit);
          pxRect(ctx, ox, oy, 14, rows - 15, 4, 4, PX.archDark, unit);
          pxRect(ctx, ox, oy, 15, rows - 14, 2, 2, style === "serratedCream" ? PX.glassTeal : PX.archMid, unit);
        }
      } else if (style === "steppedSemiMint") {
        pxRect(ctx, ox, oy, 0, rows - 6, cols, 6, wallCol, unit);
        pxRect(ctx, ox, oy, 0, rows - 6, cols, 2, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 0, rows - 4, cols, 1, shadeCol, unit);
        const steps = [
          [rows - 7, 1, 31], [rows - 8, 1, 31], [rows - 9, 3, 29], [rows - 10, 3, 29],
          [rows - 11, 5, 27], [rows - 12, 6, 26], [rows - 13, 8, 24], [rows - 14, 9, 23],
          [rows - 15, 10, 22], [rows - 16, 11, 21], [rows - 17, 12, 20], [rows - 18, 13, 19]
        ];
        for (const [rowIdx, left, right] of steps) {
          fillRowSpan(rowIdx, left, right, wallCol);
          drawTrimEdge(rowIdx, left, right, PX.trimLight);
        }
        pxRect(ctx, ox, oy, 11, rows - 19, 10, 2, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 13, rows - 20, 6, 1, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 0, rows - 10, 3, 4, PX.trimLight, unit);
        pxRect(ctx, ox, oy, cols - 3, rows - 10, 3, 4, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 13, rows - 14, 6, 5, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 14, rows - 13, 4, 3, shadeCol, unit);
        pxRect(ctx, ox, oy, 15, rows - 12, 2, 1, PX.trimLight, unit);
      } else if (style === "waveCoral") {
        pxRect(ctx, ox, oy, 0, rows - 6, cols, 6, wallCol, unit);
        pxRect(ctx, ox, oy, 0, rows - 6, cols, 2, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 0, rows - 4, cols, 1, shadeCol, unit);
        pxRect(ctx, ox, oy, 1, rows - 10, 7, 4, wallCol, unit);
        pxRect(ctx, ox, oy, 2, rows - 11, 5, 1, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 1, rows - 10, 2, 4, PX.trimLight, unit);
        pxRect(ctx, ox, oy, cols - 8, rows - 10, 7, 4, wallCol, unit);
        pxRect(ctx, ox, oy, cols - 7, rows - 11, 5, 1, PX.trimLight, unit);
        pxRect(ctx, ox, oy, cols - 3, rows - 10, 2, 4, PX.trimLight, unit);
        const waveRows = [
          [rows - 7, 2, 30], [rows - 8, 2, 30], [rows - 9, 4, 28], [rows - 10, 6, 26],
          [rows - 11, 7, 25], [rows - 12, 8, 24], [rows - 13, 9, 23], [rows - 14, 10, 22],
          [rows - 15, 11, 21], [rows - 16, 12, 20], [rows - 17, 13, 19]
        ];
        for (const [rowIdx, left, right] of waveRows) {
          fillRowSpan(rowIdx, left, right, wallCol);
          drawTrimEdge(rowIdx, left, right, PX.trimLight);
        }
        pxRect(ctx, ox, oy, 12, rows - 18, 8, 2, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 14, rows - 19, 4, 1, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 13, rows - 14, 6, 5, shadeCol, unit);
        pxRect(ctx, ox, oy, 14, rows - 13, 4, 3, PX.trimLight, unit);
        pxRect(ctx, ox, oy, 15, rows - 12, 2, 1, wallCol, unit);
      }
    };

    drawGable(SLOTS.sampleGableCream, PX.wallCream, PX.wallCreamShade, "serratedCream");
    drawGable(SLOTS.sampleGablePink, PX.wallPink, PX.wallPinkShade, "serratedPink");
    drawGable(SLOTS.sampleGableOchre, PX.wallOchre, PX.wallOchreShade, "serratedOchre");
    drawGable(SLOTS.sampleGableMint, PX.wallMint, PX.wallMintShade, "steppedSemiMint");
    drawGable(SLOTS.sampleGableWave, PX.wallPink, PX.wallPinkShade, "waveCoral");

    const drawUpperFacade = (slot, wallCol, shadeCol, winCount, winStyle, whiteRailing = true) => {
      const [ox, oy, w, h] = slot;
      const unit = 4;
      const cols = w / unit;
      const rows = h / unit;
      pxRect(ctx, ox, oy, 0, 0, cols, rows, wallCol, unit);
      pxRect(ctx, ox, oy, 0, 0, 2, rows, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 2, 0, 1, rows, shadeCol, unit);
      pxRect(ctx, ox, oy, cols - 2, 0, 2, rows, PX.trimLight, unit);
      pxRect(ctx, ox, oy, cols - 3, 0, 1, rows, shadeCol, unit);
      pxRect(ctx, ox, oy, 0, 0, cols, 2, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 0, 2, cols, 1, shadeCol, unit);
      const winXs = winCount === 4 ? [3, 10, 17, 24] : (winCount === 3 ? [4, 13, 22] : [6, 19]);
      const winW = winCount === 4 ? 5 : (winCount === 3 ? 6 : 7);
      const winTop = 5;
      const winH = 15;
      winXs.forEach((wx, idx) => {
        pxRect(ctx, ox, oy, wx - 1, winTop - 1, winW + 2, winH + 2, shadeCol, unit);
        pxRect(ctx, ox, oy, wx - 1, winTop - 1, winW + 2, 1, PX.trimLight, unit);
        pxRect(ctx, ox, oy, wx, winTop, winW, winH, PX.archDark, unit);
        const iw = winW - 2;
        const halfW = Math.floor(iw / 2);
        if (winStyle === "manchuAmber") {
          pxRect(ctx, ox, oy, wx + 1, winTop + 1, halfW, 5, PX.glassTeal, unit);
          pxRect(ctx, ox, oy, wx + 1 + halfW, winTop + 1, iw - halfW, 5, PX.glassAmber, unit);
          pxRect(ctx, ox, oy, wx + 1, winTop + 7, halfW, 6, idx % 2 === 0 ? PX.glassAmber : PX.glassTeal, unit);
          pxRect(ctx, ox, oy, wx + 1 + halfW, winTop + 7, iw - halfW, 6, PX.glassTeal, unit);
          pxRect(ctx, ox, oy, wx + 1, winTop + 6, iw, 1, PX.trimLight, unit);
        } else if (winStyle === "darkTeal") {
          pxRect(ctx, ox, oy, wx + 1, winTop + 1, iw, 5, "#426a67", unit);
          pxRect(ctx, ox, oy, wx + 1, winTop + 7, iw, 6, "#375657", unit);
          pxRect(ctx, ox, oy, wx + 1, winTop + 6, iw, 1, "#9a897a", unit);
        } else {
          pxRect(ctx, ox, oy, wx + 1, winTop + 1, iw, 5, "#4a8c7e", unit);
          pxRect(ctx, ox, oy, wx + 1, winTop + 7, iw, 6, "#3c746a", unit);
          pxRect(ctx, ox, oy, wx + 1, winTop + 6, iw, 1, PX.trimLight, unit);
        }
        pxRect(ctx, ox, oy, wx + Math.floor(winW / 2), winTop + 1, 1, winH - 2, PX.archDark, unit);
        pxRect(ctx, ox, oy, wx - 1, winTop + winH, winW + 2, 1, PX.trimLight, unit);
      });
      const railCol = whiteRailing ? PX.trimLight : wallCol;
      pxRect(ctx, ox, oy, 0, 22, cols, 2, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 0, 24, cols, 4, shadeCol, unit);
      for (let bx = 3; bx < cols - 3; bx += 3) {
        pxRect(ctx, ox, oy, bx, 24, 2, 4, railCol, unit);
      }
      pxRect(ctx, ox, oy, 0, 28, cols, 2, PX.trimLight, unit);
      bleedSlot(ctx, ox, oy, w, h);
    };

    drawUpperFacade(SLOTS.sampleUpperCream, PX.wallCream, PX.wallCreamShade, 4, "manchuAmber", true);
    drawUpperFacade(SLOTS.sampleUpperPink, PX.wallPink, PX.wallPinkShade, 3, "darkTeal", true);
    drawUpperFacade(SLOTS.sampleUpperOchre, PX.wallOchre, PX.wallOchreShade, 2, "manchuAmber", true);
    drawUpperFacade(SLOTS.sampleUpperMint, PX.wallMint, PX.wallMintShade, 2, "cyanGreen", true);
    drawUpperFacade(SLOTS.sampleUpperCoral, PX.wallPink, PX.wallPinkShade, 2, "cyanGreen", true);

    {
      const [ox, oy, w, h] = SLOTS.sampleSkybridge;
      const unit = 4;
      const cols = w / unit;
      ctx.clearRect(ox, oy, w, h);
      pxRect(ctx, ox, oy, 0, 1, cols, 2, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 0, 3, 3, 7, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 16, 3, 3, 7, PX.trimLight, unit);
      pxRect(ctx, ox, oy, cols - 3, 3, 3, 7, PX.trimLight, unit);
      for (let bx = 5; bx <= 13; bx += 3) pxRect(ctx, ox, oy, bx, 3, 2, 7, "#efe5d2", unit);
      for (let bx = 21; bx <= 29; bx += 3) pxRect(ctx, ox, oy, bx, 3, 2, 7, "#efe5d2", unit);
      pxRect(ctx, ox, oy, 0, 10, cols, 3, PX.wallCream, unit);
      pxRect(ctx, ox, oy, 0, 10, cols, 1, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 0, 13, cols, 1, PX.wallCreamShade, unit);
      pxRect(ctx, ox, oy, 0, 14, cols, 3, PX.wallCream, unit);
      pxRect(ctx, ox, oy, 0, 14, 3, 14, PX.wallCream, unit);
      pxRect(ctx, ox, oy, 16, 14, 3, 14, PX.wallCream, unit);
      pxRect(ctx, ox, oy, cols - 3, 14, 3, 14, PX.wallCream, unit);
      for (const archLeft of [3, 19]) {
        pxRect(ctx, ox, oy, archLeft, 17, 2, 2, PX.wallCreamShade, unit);
        pxRect(ctx, ox, oy, archLeft + 11, 17, 2, 2, PX.wallCreamShade, unit);
        pxRect(ctx, ox, oy, archLeft, 19, 1, 2, PX.wallCreamShade, unit);
        pxRect(ctx, ox, oy, archLeft + 12, 19, 1, 2, PX.wallCreamShade, unit);
        pxRect(ctx, ox, oy, archLeft + 2, 16, 9, 1, PX.trimLight, unit);
      }
    }

    {
      const [ox, oy, w, h] = SLOTS.sampleArcadeArch;
      const unit = 4;
      const cols = w / unit;
      const rows = h / unit;
      ctx.clearRect(ox, oy, w, h);
      pxRect(ctx, ox, oy, 0, 0, cols, 6, PX.wallCream, unit);
      pxRect(ctx, ox, oy, 0, 0, cols, 2, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 0, 6, 3, rows - 6, PX.wallCream, unit);
      pxRect(ctx, ox, oy, 0, 6, 1, rows - 6, PX.trimLight, unit);
      pxRect(ctx, ox, oy, cols - 3, 6, 3, rows - 6, PX.wallCream, unit);
      pxRect(ctx, ox, oy, cols - 1, 6, 1, rows - 6, PX.wallCreamShade, unit);
      pxRect(ctx, ox, oy, 3, 6, 4, 2, PX.wallCream, unit);
      pxRect(ctx, ox, oy, cols - 7, 6, 4, 2, PX.wallCream, unit);
      pxRect(ctx, ox, oy, 3, 8, 2, 2, PX.wallCream, unit);
      pxRect(ctx, ox, oy, cols - 5, 8, 2, 2, PX.wallCream, unit);
      pxRect(ctx, ox, oy, 3, 10, 1, 2, PX.wallCreamShade, unit);
      pxRect(ctx, ox, oy, cols - 4, 10, 1, 2, PX.wallCreamShade, unit);
      pxRect(ctx, ox, oy, 7, 5, 10, 1, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 5, 6, 2, 1, PX.trimLight, unit);
      pxRect(ctx, ox, oy, cols - 7, 6, 2, 1, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 4, 8, 1, 2, PX.trimLight, unit);
      pxRect(ctx, ox, oy, cols - 5, 8, 1, 2, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 0, rows - 3, 3, 3, PX.wallCreamShade, unit);
      pxRect(ctx, ox, oy, cols - 3, rows - 3, 3, 3, PX.wallCreamShade, unit);
    }

    {
      const [ox, oy, w, h] = SLOTS.sampleSideGrey;
      const unit = 4;
      const cols = w / unit;
      const rows = h / unit;
      pxRect(ctx, ox, oy, 0, 0, cols, rows, "#cfd2cf", unit);
      for (let rowIdx = 2; rowIdx < rows; rowIdx += 3) {
        for (let colIdx = (rowIdx % 6 === 0 ? 0 : 2); colIdx < cols; colIdx += 4) {
          pxRect(ctx, ox, oy, colIdx, rowIdx, 2, 1, "#bfc4c1", unit);
        }
      }
      pxRect(ctx, ox, oy, 0, 0, cols, 2, "#f3eee3", unit);
      pxRect(ctx, ox, oy, 0, rows - 4, cols, 4, "#b2b6b3", unit);
      bleedSlot(ctx, ox, oy, w, h);
    }

    {
      const [ox, oy, w, h] = SLOTS.sampleLantern;
      const unit = 4;
      const cols = w / unit;
      const rows = h / unit;
      pxRect(ctx, ox, oy, 0, 0, cols, rows, "#d63820", unit);
      pxRect(ctx, ox, oy, 0, 0, cols, 2, "#e8b648", unit);
      pxRect(ctx, ox, oy, 0, rows - 2, cols, 2, "#e8b648", unit);
      pxRect(ctx, ox, oy, 2, 2, 10, rows - 4, "#ea4d2b", unit);
      pxRect(ctx, ox, oy, 4, 3, 6, rows - 6, "#f78336", unit);
      pxRect(ctx, ox, oy, 5, 4, 4, rows - 8, "#ffd266", unit);
      pxRect(ctx, ox, oy, 0, 2, 1, rows - 4, "#9d2515", unit);
      pxRect(ctx, ox, oy, cols - 1, 2, 1, rows - 4, "#9d2515", unit);
      bleedSlot(ctx, ox, oy, w, h);
    }

    {
      const [ox, oy, w, h] = SLOTS.sampleCavity;
      const unit = 4;
      const cols = w / unit;
      const rows = h / unit;
      pxRect(ctx, ox, oy, 0, 0, cols, rows, "#423128", unit);
      pxRect(ctx, ox, oy, 0, 0, cols, 3, "#30221b", unit);
      pxRect(ctx, ox, oy, 3, 5, 8, 9, "#574135", unit);
      pxRect(ctx, ox, oy, 4, 6, 3, 8, "#6a5041", unit);
      pxRect(ctx, ox, oy, 8, 6, 2, 8, "#6a5041", unit);
      bleedSlot(ctx, ox, oy, w, h);
    }

    {
      const [ox, oy, w, h] = SLOTS.sampleMintSide;
      const unit = 4;
      pxRect(ctx, ox, oy, 0, 0, 14, 14, PX.wallMint, unit);
      pxRect(ctx, ox, oy, 0, 0, 14, 2, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 0, 2, 14, 1, PX.wallMintShade, unit);
      pxRect(ctx, ox, oy, 4, 5, 6, 6, PX.archDark, unit);
      pxRect(ctx, ox, oy, 5, 6, 4, 4, "#4b8577", unit);
      pxRect(ctx, ox, oy, 4, 11, 6, 1, PX.trimLight, unit);
      bleedSlot(ctx, ox, oy, w, h);
    }
    {
      const [ox, oy, w, h] = SLOTS.samplePinkSide;
      const unit = 4;
      pxRect(ctx, ox, oy, 0, 0, 14, 14, PX.wallPink, unit);
      pxRect(ctx, ox, oy, 0, 0, 14, 2, PX.trimLight, unit);
      pxRect(ctx, ox, oy, 0, 2, 14, 1, PX.wallPinkShade, unit);
      for (const wx of [2, 6, 10]) {
        pxRect(ctx, ox, oy, wx, 5, 2, 5, PX.archDark, unit);
        pxRect(ctx, ox, oy, wx, 10, 2, 1, PX.trimLight, unit);
      }
      bleedSlot(ctx, ox, oy, w, h);
    }

    const vxSwatches = {
      vxTrimTop:       "#fff8ea",
      vxTrimFront:     "#f1e6d2",
      vxTrimShade:     "#d0c1a8",
      vxTrimUnder:     "#9d8d76",
      vxCreamMid:      "#f5e7cb",
      vxCreamShade:    "#d8c39f",
      vxCreamDark:     "#b59e7a",
      vxPinkMid:       "#ebbcb1",
      vxPinkShade:     "#cc9589",
      vxPinkDark:      "#a87166",
      vxOchreMid:      "#f1d79f",
      vxOchreShade:    "#d0b074",
      vxOchreDark:     "#ae8c52",
      vxMintMid:       "#c9dec4",
      vxMintShade:     "#a5bfa1",
      vxMintDark:      "#819d7f",
      vxGreyLight:     "#d9dcd8",
      vxGreyMid:       "#c1c6c2",
      vxGreyShade:     "#9ea4a1",
      vxWinDark:       "#382a22",
      vxGlassTeal:     "#4b9689",
      vxGlassTealDark: "#336862",
      vxGlassAmber:    "#e5ab48",
      vxGlassBlueDark: "#3a5b5c",
      vxCavityDeep:    "#32231b",
      vxCavityMid:     "#4d392e",
      vxCavityDoor:    "#6a5040",
      vxRoofLight:     "#82919e",
      vxRoofMid:       "#697886",
      vxRoofDark:      "#515f6c",
      vxRidgeTop:      "#e5ddd0",
      vxRidgeSide:     "#bcb3a4",
      vxLanternGold:   "#f6ca56",
      vxLanternOrange: "#f36d2d",
      vxLanternRed:    "#d5351e",
      vxLanternDeep:   "#8f1f12",
      vxWoodDark:      "#5d3b24",
      vxWoodMid:       "#8f5c35",
      vxWoodLight:     "#ba8350",
      vxStoneTop:      "#f0eae0",
      vxStoneLight:    "#dfd8cd",
      vxStoneMid:      "#c5bdb1",
      vxStoneShade:    "#a79e92",
      vxStoneDark:     "#7e766b",
      vxSteelLight:    "#9fb5c3",
      vxSteelMid:      "#758e9e",
      vxSteelDark:     "#4f6675",
      vxLeafLight:     "#97c865",
      vxLeafMid:       "#6ea74c",
      vxLeafDark:      "#4e823a",
      vxLeafDeep:      "#355e2c",
      vxTrunkMid:      "#7d5940",
      vxTrunkDark:     "#543a29",
      vxBrickLight:    "#e6ddd0",
      vxBrickMid:      "#cfc4b3",
      vxBrickShade:    "#b2a594",
      vxBrickDark:     "#887c6c",
      vxCanopyLight:   "#f4dfb3",
      vxCanopyShade:   "#d9b880",
      vxGreenAwning:   "#5b9b6f",
      vxGreenAwningDark:"#3e7451",
      vxCarWhite:      "#f4efe6",
      vxCarBlue:       "#7ea9c9",
      vxCarYellow:     "#eec66c",
      vxClockFace:     "#fdf8ec",
      vxClockHand:     "#3a2d25",
      vxWaterFoam:     "#96ded0",
      vxWaterEdge:     "#57aba0",
      vxParkingPad:    "#bab4aa",
      vxParkingLine:   "#f3ede2",
      vxPedShirtA:     "#597ea6",
      vxPedShirtB:     "#d86c57",
      vxPedShirtC:     "#e3b459",
      vxPedSkin:       "#f2cfb0"
    };
    for (const [slotName, color] of Object.entries(vxSwatches)) {
      const [ox, oy, w, h] = SLOTS[slotName];
      ctx.fillStyle = color;
      ctx.fillRect(ox, oy, w, h);
      bleedSlot(ctx, ox, oy, w, h);
    }
  }

  function drawFallbackBaseTiles(ctx) {
    {
      const [ox, oy, w, h] = SLOTS.river;
      ctx.fillStyle = PX.riverBase;
      ctx.fillRect(ox, oy, w, h);
      const bands = [
        [10, 12, 76, 12, "#80d1c2"],
        [108, 22, 58, 10, "#62b7a8"],
        [24, 48, 86, 12, "#7fd0c1"],
        [124, 58, 46, 10, "#60b5a6"],
        [8, 86, 68, 12, "#62b7a8"],
        [92, 96, 78, 12, "#82d3c4"],
        [30, 126, 82, 12, "#7fd0c1"],
        [118, 138, 52, 10, "#61b6a7"],
        [14, 160, 74, 12, "#81d2c3"]
      ];
      for (const [bx, by, bw, bh, col] of bands) {
        ctx.fillStyle = col;
        ctx.fillRect(ox + bx, oy + by, bw, bh);
      }
      bleedSlot(ctx, ox, oy, w, h);
    }
    {
      const [ox, oy, w, h] = SLOTS.roofTile;
      ctx.fillStyle = PX.roofMid;
      ctx.fillRect(ox, oy, w, h);
      for (let x = 0; x < w; x += 32) {
        ctx.fillStyle = "#7a8996";
        ctx.fillRect(ox + x, oy, 16, h);
        ctx.fillStyle = "#5f6e7c";
        ctx.fillRect(ox + x + 16, oy, 16, h);
      }
      for (let y = 0; y < h; y += 30) {
        ctx.fillStyle = "rgba(48,58,68,0.14)";
        ctx.fillRect(ox, oy + y, w, 4);
      }
      bleedSlot(ctx, ox, oy, w, h);
    }
    {
      const [ox, oy, w, h] = SLOTS.plazaTile;
      const cell = 32;
      for (let y = 0; y < h; y += cell) {
        for (let x = 0; x < w; x += cell) {
          const isLight = ((x / cell + y / cell) % 2) === 0;
          ctx.fillStyle = isLight ? "#eedac4" : "#e5cdb4";
          ctx.fillRect(ox + x, oy + y, cell, cell);
          ctx.fillStyle = "#dbc1a5";
          ctx.fillRect(ox + x, oy + y + cell - 2, cell, 2);
          ctx.fillRect(ox + x + cell - 2, oy + y, 2, cell);
        }
      }
      bleedSlot(ctx, ox, oy, w, h);
    }
    {
      const [ox, oy, w, h] = SLOTS.promenade;
      ctx.fillStyle = "#dbd4ca";
      ctx.fillRect(ox, oy, w, h);
      const rowH = 32;
      const slabW = 58;
      for (let row = 0; row < 4; row += 1) {
        const ry = row * rowH;
        const shift = (row % 2) * 29;
        for (let col = -1; col < 3; col += 1) {
          const sx = col * slabW + shift;
          const drawX = Math.max(0, sx);
          const drawW = Math.min(w, sx + slabW) - drawX;
          if (drawW <= 0) continue;
          ctx.fillStyle = ((row + col + 4) % 2 === 0) ? "#dcd5cb" : "#d4cdc3";
          ctx.fillRect(ox + drawX, oy + ry, drawW, rowH);
          ctx.fillStyle = "#c8c0b6";
          ctx.fillRect(ox + drawX, oy + ry + rowH - 2, drawW, 2);
          if (sx >= 0 && sx < w) {
            ctx.fillRect(ox + sx, oy + ry, 2, rowH);
          }
        }
      }
      bleedSlot(ctx, ox, oy, w, h);
    }
    {
      const [ox, oy, w, h] = SLOTS.embankment;
      ctx.fillStyle = "#c4bcb0";
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = "#dfd8cd";
      ctx.fillRect(ox, oy, w, 12);
      ctx.fillStyle = "#a69e92";
      ctx.fillRect(ox, oy + 12, w, 4);
      ctx.fillStyle = "#b5ada1";
      for (let x = 0; x < w; x += 30) {
        ctx.fillRect(ox + x, oy + 16, 4, h - 24);
      }
      ctx.fillStyle = "#4f7c73";
      ctx.fillRect(ox, oy + h - 8, w, 8);
      bleedSlot(ctx, ox, oy, w, h);
    }
    // 6. Shuibutou stone steps
    {
      const [ox, oy, w, h] = SLOTS.stoneStep;
      ctx.fillStyle = PX.stoneLight;
      ctx.fillRect(ox, oy, w, h);
      for (let y = 0; y < h; y += 16) {
        ctx.fillStyle = PX.stoneMid;
        ctx.fillRect(ox, oy + y + 8, w, 4);
        ctx.fillStyle = PX.stoneDark;
        ctx.fillRect(ox, oy + y + 12, w, 4);
      }
      bleedSlot(ctx, ox, oy, w, h);
    }
    // 7. Parking pad
    {
      const [ox, oy, w, h] = SLOTS.parkingPad;
      ctx.fillStyle = "#b9b5ad";
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = "#f2ece0";
      ctx.fillRect(ox + 14, oy + 36, w - 22, 6);
      ctx.fillRect(ox + 14, oy + 76, w - 22, 6);
      ctx.fillRect(ox + 14, oy + 116, w - 22, 6);
      bleedSlot(ctx, ox, oy, w, h);
    }
    // 8. Wood sampan boat & cafe umbrella
    {
      const [ox, oy, w, h] = SLOTS.woodBoat;
      ctx.fillStyle = PX.wood;
      ctx.fillRect(ox, oy, w, h);
      for (let y = 0; y < h; y += 8) {
        ctx.fillStyle = PX.woodDark;
        ctx.fillRect(ox, oy + y + 4, w, 4);
      }
      bleedSlot(ctx, ox, oy, w, h);
    }
    {
      const [ox, oy, w, h] = SLOTS.umbrella;
      ctx.fillStyle = PX.canopy;
      ctx.fillRect(ox, oy, w, h);
      for (let x = 0; x < w; x += 16) {
        ctx.fillStyle = PX.trimLight;
        ctx.fillRect(ox + x, oy, 8, h);
      }
      bleedSlot(ctx, ox, oy, w, h);
    }

    // 9. Modular pixel-art qilou facades & Lingnan walls
    drawQilouTile(ctx, SLOTS.qilouCream, PX.wallCream, PX.wallCreamShade);
    drawQilouTile(ctx, SLOTS.qilouPink, PX.wallPink, PX.wallPinkShade);
    drawQilouTile(ctx, SLOTS.qilouMint, PX.wallMint, PX.wallMintShade);
    drawQilouTile(ctx, SLOTS.qilouOchre, PX.wallOchre, PX.wallOchreShade);
    drawQilouTile(ctx, SLOTS.qilouLantern, PX.wallPink, PX.wallPinkShade, { lanterns: true });
    drawLingnanWall(ctx, SLOTS.lingnanWall);
    bleedSlot(ctx, ...SLOTS.lingnanWall);

    // 10. Xinshi arched sky-bridge
    {
      const [ox, oy, w, h] = SLOTS.xinshiBridge;
      ctx.clearRect(ox, oy, w, h);
      pxRect(ctx, ox, oy, 0, 2, 42, 9, PX.wallCream, 4);
      pxRect(ctx, ox, oy, 0, 0, 42, 2, PX.trimLight, 4);
      pxRect(ctx, ox, oy, 0, 10, 42, 2, PX.wallCreamShade, 4);
      // 3 arches below bridge deck
      for (const px of [0, 13, 26, 39]) {
        pxRect(ctx, ox, oy, px, 11, 3, 13, PX.wallCreamShade, 4);
      }
      for (const ax of [3, 16, 29]) {
        pxRect(ctx, ox, oy, ax, 11, 10, 2, PX.wallCream, 4);
        pxRect(ctx, ox, oy, ax, 13, 2, 2, PX.wallCreamShade, 4);
        pxRect(ctx, ox, oy, ax + 8, 13, 2, 2, PX.wallCreamShade, 4);
      }
    }

    // 11. Volumetric lush 4-tone pixel-art tree foliage tile & leafy cluster sprite
    {
      const [ox, oy, w, h] = SLOTS.treeLeaf;
      ctx.fillStyle = PX.leafMid;
      ctx.fillRect(ox, oy, w, h);
      const pattern = [
        [2, 2, 6, 4, PX.leafLight], [12, 4, 8, 4, PX.leafLight], [22, 2, 6, 4, PX.leafLight],
        [0, 10, 8, 6, PX.leafDark], [10, 12, 10, 6, PX.leafLight], [24, 10, 6, 6, PX.leafDark],
        [4, 20, 10, 6, PX.leafDark], [16, 18, 8, 6, PX.leafLight], [26, 20, 6, 8, PX.leafDeep],
        [2, 26, 8, 6, PX.leafDeep], [14, 26, 10, 6, PX.leafDark]
      ];
      for (const [gx, gy, gw, gh, col] of pattern) {
        pxRect(ctx, ox, oy, gx, gy, gw, gh, col, 4);
      }
      bleedSlot(ctx, ox, oy, w, h);
    }
    {
      const [ox, oy, w, h] = SLOTS.treeCluster;
      ctx.clearRect(ox, oy, w, h);
      // Rounded multi-lobed pixel tree crown with alpha transparency outside leaves
      const cx = 16, cy = 16;
      for (let gy = 1; gy < 31; gy += 1) {
        for (let gx = 1; gx < 31; gx += 1) {
          const dist = Math.hypot((gx - cx) * 0.95, (gy - cy) * 1.05);
          const lobe = Math.sin(gx * 0.65) * 1.4 + Math.cos(gy * 0.72) * 1.4;
          if (dist < 11.8 + lobe) {
            let col = PX.leafMid;
            if (gy < 12 && gx < 20 && dist < 10.5) col = PX.leafLight;
            else if (gy > 20 || dist > 10.6) col = PX.leafDark;
            if (gy > 24 && dist > 9.5) col = PX.leafDeep;
            pxRect(ctx, ox, oy, gx, gy, 1, 1, col, 4);
          }
        }
      }
    }

    // 12. Market stalls (striped awnings)
    const drawStall = (slot, stripeA, stripeB) => {
      const [ox, oy, w, h] = slot;
      for (let x = 0; x < w; x += 12) {
        ctx.fillStyle = ((x / 12) % 2 === 0) ? stripeA : stripeB;
        ctx.fillRect(ox + x, oy, 12, h);
      }
      ctx.fillStyle = "rgba(60,40,20,0.18)";
      ctx.fillRect(ox, oy + h - 8, w, 8);
      bleedSlot(ctx, ox, oy, w, h);
    };
    drawStall(SLOTS.stallCream, "#f8edd3", "#e6c388");
    drawStall(SLOTS.stallGreen, "#f6f1e4", "#559a74");

    // 13. Parked car pixel textures
    const drawCar = (slot, body, shade) => {
      const [ox, oy, w, h] = slot;
      ctx.fillStyle = body;
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = shade;
      ctx.fillRect(ox, oy + h - 16, w, 16);
      ctx.fillStyle = "#5c6d7a";
      ctx.fillRect(ox + 16, oy + 8, w - 32, 24);
      ctx.fillStyle = "#9fb6c4";
      ctx.fillRect(ox + 20, oy + 12, w - 40, 12);
      bleedSlot(ctx, ox, oy, w, h);
    };
    drawCar(SLOTS.carWhite, "#f7f3e8", "#d4cec2");
    drawCar(SLOTS.carBlue, "#7ea9c9", "#5c84a3");
    drawCar(SLOTS.carYellow, "#f0cf7f", "#cca95c");

    // 14. Ridge cap & parapet top
    {
      const [ox, oy, w, h] = SLOTS.ridgeCap;
      ctx.fillStyle = PX.roofRidge;
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = "#c7bfb0";
      ctx.fillRect(ox, oy + h - 8, w, 8);
      bleedSlot(ctx, ox, oy, w, h);
    }
    {
      const [ox, oy, w, h] = SLOTS.parapetTop;
      ctx.fillStyle = PX.trimLight;
      ctx.fillRect(ox, oy, w, h);
      ctx.fillStyle = PX.wallCreamShade;
      ctx.fillRect(ox, oy + h - 12, w, 12);
      bleedSlot(ctx, ox, oy, w, h);
    }

    // 15. Tiny strolling pixel pedestrians (matching map.jpg scale)
    const drawPerson = (slot, shirt, pants) => {
      const [ox, oy, w, h] = slot;
      ctx.clearRect(ox, oy, w, h);
      pxRect(ctx, ox, oy, 4, 2, 4, 3, "#3c322c", 4); // hair
      pxRect(ctx, ox, oy, 4, 4, 4, 2, "#f0c9a8", 4); // face
      pxRect(ctx, ox, oy, 3, 6, 6, 5, shirt, 4);     // shirt
      pxRect(ctx, ox, oy, 4, 11, 2, 4, pants, 4);    // left leg
      pxRect(ctx, ox, oy, 6, 11, 2, 4, pants, 4);    // right leg
    };
    drawPerson(SLOTS.pedestrianA, "#f4efe4", "#44515e");
    drawPerson(SLOTS.pedestrianB, "#5e87a8", "#3b424c");
    drawPerson(SLOTS.pedestrianC, "#d65d45", "#444a52");

    // Fallback hero slots before map.jpg loads (immediately replaced on load!)
    drawQilouTile(ctx, SLOTS.haiguanFront, PX.wallCream, PX.wallCreamShade);
    drawQilouTile(ctx, SLOTS.museumFront, PX.wallCream, PX.wallOchreShade);
    ctx.fillStyle = PX.wallCream;
    ctx.fillRect(...SLOTS.haiguanTower);
    ctx.fillStyle = PX.stoneLight;
    ctx.fillRect(...SLOTS.qimingliGate);
    ctx.fillStyle = PX.stoneLight;
    ctx.fillRect(...SLOTS.pengjiangSide);
    ctx.fillStyle = PX.steel;
    ctx.fillRect(...SLOTS.ironTruss);
    ctx.drawImage(ctx.canvas, ...SLOTS.treeCluster, ...SLOTS.banyanTop);
    ctx.drawImage(ctx.canvas, ...SLOTS.treeCluster, ...SLOTS.banyanSide);
    drawSampleSegmentTiles(ctx);
  }

  // Copy normalized region from source image into atlas slot, with optional alpha keying or shear rectification
  function blitCropped(ctx, img, srcU, srcV, srcW, srcH, slot, opts = {}) {
    const [dx, dy, dw, dh] = slot;
    const sx = Math.round(img.width * srcU);
    const sy = Math.round(img.height * srcV);
    const sw = Math.round(img.width * srcW);
    const sh = Math.round(img.height * srcH);

    const tmp = document.createElement("canvas");
    tmp.width = dw;
    tmp.height = dh;
    const tctx = tmp.getContext("2d");
    tctx.imageSmoothingEnabled = false;
    if (opts.shearY) {
      tctx.save();
      tctx.translate(0, opts.shearY > 0 ? 0 : -dw * opts.shearY);
      tctx.transform(1, opts.shearY, 0, 1, 0, 0);
      tctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
      tctx.restore();
    } else {
      tctx.drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);
    }

    if (opts.keyFn) {
      const imgData = tctx.getImageData(0, 0, dw, dh);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        if (opts.keyFn(d[i], d[i + 1], d[i + 2], (i / 4) % dw, Math.floor((i / 4) / dw), dw, dh)) {
          d[i + 3] = 0;
        }
      }
      tctx.putImageData(imgData, 0, 0);
    }

    ctx.clearRect(dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, dx, dy);
    if (!opts.noBleed) bleedSlot(ctx, dx, dy, dw, dh);
  }

  function applyOriginalTextures() {}

  function createPixelAtlas(onUpdate) {
    const canvas = document.createElement("canvas");
    canvas.width = ATLAS_SIZE;
    canvas.height = ATLAS_SIZE;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    drawFallbackBaseTiles(ctx);

    const state = {
      canvas,
      size: ATLAS_SIZE,
      loadedIso: true,
      loadedTop: true,
      getUvRect
    };

    applyOriginalTextures(ctx);
    if (typeof onUpdate === "function") {
      setTimeout(() => onUpdate(canvas, state), 0);
    }

    return state;
  }

  window.ChangdiPixelAtlas = {
    createPixelAtlas,
    getUvRect,
    ATLAS_SIZE
  };
})();
