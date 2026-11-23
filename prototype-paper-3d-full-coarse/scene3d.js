(() => {
  "use strict";

  const DEG = Math.PI / 180;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const lerp = (start, end, ratio) => start + (end - start) * ratio;
  const easeInOutCubic = ratio => ratio < 0.5
    ? 4 * ratio * ratio * ratio
    : 1 - Math.pow(-2 * ratio + 2, 3) / 2;
  const easeOutCubic = ratio => 1 - Math.pow(1 - ratio, 3);

  const toWorld = (u, v) => [u - 50, (v - 50) * 1.5];

  const hexToRgb = hex => {
    const clean = hex.replace("#", "");
    const num = parseInt(clean, 16);
    return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
  };

  // ── 4x4 Column-Major Matrix Utilities ───────────────────────────────────
  const mat4 = {
    create: () => new Float32Array(16),
    multiply(out, left, right) {
      for (let col = 0; col < 4; col += 1) {
        const r0 = right[col * 4];
        const r1 = right[col * 4 + 1];
        const r2 = right[col * 4 + 2];
        const r3 = right[col * 4 + 3];
        out[col * 4] = left[0] * r0 + left[4] * r1 + left[8] * r2 + left[12] * r3;
        out[col * 4 + 1] = left[1] * r0 + left[5] * r1 + left[9] * r2 + left[13] * r3;
        out[col * 4 + 2] = left[2] * r0 + left[6] * r1 + left[10] * r2 + left[14] * r3;
        out[col * 4 + 3] = left[3] * r0 + left[7] * r1 + left[11] * r2 + left[15] * r3;
      }
      return out;
    },
    perspective(out, fovy, aspect, near, far, ndcOffsetY = 0) {
      const focal = 1 / Math.tan(fovy / 2);
      const rangeInv = 1 / (near - far);
      out.fill(0);
      out[0] = focal / aspect;
      out[5] = focal;
      out[9] = -ndcOffsetY;
      out[10] = (far + near) * rangeInv;
      out[11] = -1;
      out[14] = 2 * far * near * rangeInv;
      return out;
    },
    lookAt(out, eye, target, up) {
      let zx = eye[0] - target[0];
      let zy = eye[1] - target[1];
      let zz = eye[2] - target[2];
      let len = Math.hypot(zx, zy, zz) || 1;
      zx /= len; zy /= len; zz /= len;

      let xx = up[1] * zz - up[2] * zy;
      let xy = up[2] * zx - up[0] * zz;
      let xz = up[0] * zy - up[1] * zx;
      len = Math.hypot(xx, xy, xz);
      if (len < 1e-6) { xx = 1; xy = 0; xz = 0; }
      else { xx /= len; xy /= len; xz /= len; }

      const yx = zy * xz - zz * xy;
      const yy = zz * xx - zx * xz;
      const yz = zx * xy - zy * xx;

      out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
      out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
      out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
      out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
      out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
      out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
      out[15] = 1;
      return out;
    },
    invert(out, src) {
      const a00 = src[0], a01 = src[1], a02 = src[2], a03 = src[3];
      const a10 = src[4], a11 = src[5], a12 = src[6], a13 = src[7];
      const a20 = src[8], a21 = src[9], a22 = src[10], a23 = src[11];
      const a30 = src[12], a31 = src[13], a32 = src[14], a33 = src[15];

      const b00 = a00 * a11 - a01 * a10;
      const b01 = a00 * a12 - a02 * a10;
      const b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11;
      const b04 = a01 * a13 - a03 * a11;
      const b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30;
      const b07 = a20 * a32 - a22 * a30;
      const b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31;
      const b10 = a21 * a33 - a23 * a31;
      const b11 = a22 * a33 - a23 * a32;

      const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (Math.abs(det) < 1e-10) return null;
      const invDet = 1 / det;

      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * invDet;
      out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * invDet;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * invDet;
      out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * invDet;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * invDet;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * invDet;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * invDet;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * invDet;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * invDet;
      out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * invDet;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * invDet;
      out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * invDet;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * invDet;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * invDet;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * invDet;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * invDet;
      return out;
    }
  };

  function projectPoint(vp, wx, wy, wz, width, height) {
    const cx = vp[0] * wx + vp[4] * wy + vp[8] * wz + vp[12];
    const cy = vp[1] * wx + vp[5] * wy + vp[9] * wz + vp[13];
    const cz = vp[2] * wx + vp[6] * wy + vp[10] * wz + vp[14];
    const cw = vp[3] * wx + vp[7] * wy + vp[11] * wz + vp[15];
    if (cw <= 0.001) return { x: -9999, y: -9999, depth: 999, visible: false };
    const ndcX = cx / cw;
    const ndcY = cy / cw;
    const ndcZ = cz / cw;
    return {
      x: (ndcX * 0.5 + 0.5) * width,
      y: (0.5 - ndcY * 0.5) * height,
      depth: ndcZ,
      visible: ndcZ >= -1 && ndcZ <= 1
    };
  }

  function rayIntersectsBox(origin, dir, box) {
    let tmin = -Infinity;
    let tmax = Infinity;
    for (let axis = 0; axis < 3; axis += 1) {
      const minBound = box.min[axis];
      const maxBound = box.max[axis];
      if (Math.abs(dir[axis]) < 1e-8) {
        if (origin[axis] < minBound || origin[axis] > maxBound) return null;
      } else {
        let t1 = (minBound - origin[axis]) / dir[axis];
        let t2 = (maxBound - origin[axis]) / dir[axis];
        if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
        tmin = Math.max(tmin, t1);
        tmax = Math.min(tmax, t2);
        if (tmin > tmax) return null;
      }
    }
    return tmax >= 0 ? (tmin >= 0 ? tmin : tmax) : null;
  }

  // Unified world coordinates aligned 1:1 with points.js topHotspot & topRouteNodes
  const LANDMARK_SPECS = [
    { id: "CD-R01", idx: 1, focus: [29, 2.8, -65.5], label: [29, 5.2, -65.5], base: [29, 0, -65.5], roof: [29, 4.2, -65.5], dist: 96, pitch: 44, yaw: 18 },
    { id: "CD-V01", idx: 2, focus: [-36.5, 3.0, -48.5], label: [-36.5, 7.2, -48.5], base: [-36.5, 0, -48.5], roof: [-36.5, 6.4, -48.5], dist: 84, pitch: 45, yaw: 20 },
    { id: "CD-A02", idx: 3, focus: [-14.0, 5.2, -40.0], label: [-13.5, 13.8, -39.5], base: [-14.0, 0, -40.0], roof: [-11.0, 14.5, -39.5], dist: 92, pitch: 45, yaw: 20 },
    { id: "CD-A01", idx: 4, focus: [-7.0, 4.4, -1.0], label: [-7.5, 9.6, -1.0], base: [-7.5, 0, -1.0], roof: [-7.5, 9.6, -1.0], dist: 84, pitch: 45, yaw: 22 },
    { id: "CD-A03", idx: 5, focus: [13.2, 0.2, 16.0], label: [13.2, 3.8, 16.0], base: [13.2, -1.6, 16.0], roof: [13.2, 2.4, 16.0], dist: 76, pitch: 45, yaw: 30 },
    { id: "CD-S01", idx: 6, focus: [-9.2, 3.8, 32.8], label: [-9.2, 11.4, 32.2], base: [-9.2, 0, 32.8], roof: [-9.2, 10.4, 32.8], dist: 100, pitch: 45, yaw: 40, compactRefH: 274, maxCompactBoost: 1.48 },
    { id: "CD-S02", idx: 7, focus: [-36.0, 2.8, 32.5], label: [-36.0, 7.0, 32.5], base: [-36.0, 0, 32.5], roof: [-36.0, 6.2, 32.5], dist: 82, pitch: 45, yaw: 20 },
    { id: "CD-S03", idx: 8, focus: [-34.5, 2.8, 51.0], label: [-34.5, 7.0, 51.0], base: [-34.5, 0, 51.0], roof: [-34.5, 6.0, 51.0], dist: 82, pitch: 45, yaw: 20 },
    { id: "CD-P01", idx: 9, focus: [1.5, 1.0, 57.5], label: [-1.0, 4.2, 52.5], base: [1.5, 0, 57.5], roof: [1.5, 2.4, 57.5], dist: 76, pitch: 45, yaw: 24 },
    { id: "CD-R02", idx: 10, focus: [24.5, 3.2, 67.5], label: [24.5, 7.8, 67.5], base: [24.5, 0, 67.5], roof: [24.5, 7.4, 67.5], dist: 98, pitch: 44, yaw: 18 }
  ];
  const LANDMARK_BY_ID = new Map(LANDMARK_SPECS.map(spec => [spec.id, spec]));

  const VOXEL_TIERS = {
    orig:   { id: "orig",   label: "原版", voxelUnit: 0.14 },
    medium: { id: "medium", label: "中粗", voxelUnit: 0.34 },
    coarse: { id: "coarse", label: "粗",   voxelUnit: 0.48 }
  };

  function normalizeVoxelTier(raw) {
    const key = String(raw || "").trim().toLowerCase();
    if (key === "orig" || key === "original" || key === "8941") return "orig";
    if (key === "medium" || key === "mid") return "medium";
    if (key === "coarse" || key === "chunky") return "coarse";
    return "coarse";
  }

  function readInitialVoxelTier() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      const value = params.get("tier") || params.get("voxel");
      return value ? normalizeVoxelTier(value) : "coarse";
    } catch {
      return "coarse";
    }
  }

  const VOXEL_PALETTES = {
    cream: { mid: "vxCreamMid", shade: "vxCreamShade", dark: "vxCreamDark" },
    pink:  { mid: "vxPinkMid",  shade: "vxPinkShade",  dark: "vxPinkDark"  },
    ochre: { mid: "vxOchreMid", shade: "vxOchreShade", dark: "vxOchreDark" },
    mint:  { mid: "vxMintMid",  shade: "vxMintShade",  dark: "vxMintDark"  },
    grey:  { mid: "vxGreyLight", shade: "vxGreyMid",   dark: "vxGreyShade" }
  };

  // ── Textured Pixel-Art Mesh Builder ─────────────────────────────────────
  class PixelMeshBuilder {
    constructor() {
      // 16 floats per vertex: pos(3), norm(3), uv(2), atlasRect(4), meta(4: lid, ao, flags, texScale)
      this.opaque = [];
      this.cutout = [];
      this.shadows = []; // 4 floats: pos(3), alpha(1)
      this.pickBoxes = [];
      this.sampleShopBoxes = [];
      this.sampleMeasureSegments = [];
      this.uvMap = window.ChangdiPixelAtlas.getUvRect;
    }

    addPickBox(id, minX, minY, minZ, maxX, maxY, maxZ) {
      this.pickBoxes.push({ id, min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
    }

    addSampleShopBox(id, name, minX, minY, minZ, maxX, maxY, maxZ) {
      this.sampleShopBoxes.push({ id, name, min: [minX, minY, minZ], max: [maxX, maxY, maxZ] });
    }

    addMeasureSegment(key, label, p0, p1, worldSize, note = "") {
      this.sampleMeasureSegments.push({ key, label, p0, p1, worldSize: Number(worldSize.toFixed(3)), note });
    }

    pushVert(buf, p, n, u, v, rect, lid, ao, flags) {
      buf.push(
        p[0], p[1], p[2],
        n[0], n[1], n[2],
        u, v,
        rect[0], rect[1], rect[2], rect[3],
        lid, ao, flags, rect[4]
      );
    }

    addTri(a, b, c, uvA, uvB, uvC, tileName, lid = 0, ao = [1, 1, 1], flags = 0) {
      const rect = this.uvMap(tileName);
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      const norm = [nx, ny, nz];
      const target = (flags === 3) ? this.cutout : this.opaque;
      this.pushVert(target, a, norm, uvA[0], uvA[1], rect, lid, ao[0], flags);
      this.pushVert(target, b, norm, uvB[0], uvB[1], rect, lid, ao[1], flags);
      this.pushVert(target, c, norm, uvC[0], uvC[1], rect, lid, ao[2], flags);
    }

    addQuad(a, b, c, d, tileName, lid = 0, opts = {}) {
      const uRep = opts.uRep || 1;
      const vRep = opts.vRep || 1;
      const u0 = opts.u0 || 0;
      const v0 = opts.v0 || 0;
      const ao = opts.ao || [1, 1, 1, 1];
      const flags = opts.flags || 0;
      const uvA = opts.uvA || [u0, v0 + vRep];
      const uvB = opts.uvB || [u0 + uRep, v0 + vRep];
      const uvC = opts.uvC || [u0 + uRep, v0];
      const uvD = opts.uvD || [u0, v0];
      this.addTri(a, b, c, uvA, uvB, uvC, tileName, lid, [ao[0], ao[1], ao[2]], flags);
      this.addTri(a, c, d, uvA, uvC, uvD, tileName, lid, [ao[0], ao[2], ao[3]], flags);
      if (opts.doubleSided) {
        this.addTri(a, c, b, uvA, uvC, uvB, tileName, lid, [ao[0], ao[2], ao[1]], flags);
        this.addTri(a, d, c, uvA, uvD, uvC, tileName, lid, [ao[0], ao[3], ao[2]], flags);
      }
    }

    addGroundShadow(x, z, w, d, height = 4, alpha = 0.16) {
      const sx = Math.min(3.4, height * 0.36);
      const sz = Math.min(2.6, height * 0.24);
      const x0 = x - w / 2 + sx * 0.25;
      const x1 = x + w / 2 + sx;
      const z0 = z - d / 2 + sz * 0.25;
      const z1 = z + d / 2 + sz;
      const y = 0.05;
      const p = (px, pz) => this.shadows.push(px, y, pz, alpha);
      p(x0, z0); p(x0, z1); p(x1, z1);
      p(x0, z0); p(x1, z1); p(x1, z0);
    }

    addTexturedBox(cx, baseY, cz, w, h, d, tiles, lid = 0, opts = {}) {
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const y0 = baseY, y1 = baseY + h;
      const z0 = cz - d / 2, z1 = cz + d / 2;
      const topTile = typeof tiles === "string" ? tiles : (tiles.top || tiles.side);
      const frontTile = typeof tiles === "string" ? tiles : (tiles.front || tiles.side);
      const backTile = typeof tiles === "string" ? tiles : (tiles.back || tiles.side);
      const rightTile = typeof tiles === "string" ? tiles : (tiles.right || tiles.side);
      const leftTile = typeof tiles === "string" ? tiles : (tiles.left || tiles.side);
      const baseAo = opts.noAo ? 1.0 : (baseY <= 0.25 ? 0.84 : 0.92);
      const sideAo = [baseAo, baseAo, 1, 1];
      const flags = opts.flags || 0;
      const uRepW = opts.uRepW || 1;
      const uRepD = opts.uRepD || 1;
      const vRepH = opts.vRepH || 1;

      if (!opts.noTop) {
        this.addQuad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], topTile, lid, {
          uRep: opts.topURep || 1, vRep: opts.topVRep || 1, flags: opts.topFlags || flags
        });
      }
      // Front (+Z)
      this.addQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], frontTile, lid, {
        uRep: opts.frontURep || uRepW, vRep: opts.frontVRep || vRepH, ao: sideAo, flags: opts.frontFlags || flags
      });
      // Back (-Z)
      this.addQuad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], backTile, lid, {
        uRep: uRepW, vRep: vRepH, ao: sideAo, flags
      });
      // Right (+X)
      this.addQuad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], rightTile, lid, {
        uRep: opts.rightURep || uRepD, vRep: opts.rightVRep || vRepH, ao: sideAo, flags: opts.rightFlags || flags
      });
      // Left (-X)
      this.addQuad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], leftTile, lid, {
        uRep: uRepD, vRep: vRepH, ao: sideAo, flags
      });
      if (opts.shadow) this.addGroundShadow(cx, cz, w, d, baseY + h);
    }

    addVoxelBox(x0, y0, z0, x1, y1, z1, tiles, lid = 6, opts = {}) {
      if (x1 <= x0 + 0.001 || y1 <= y0 + 0.001 || z1 <= z0 + 0.001) return;
      const t = typeof tiles === "string" ? { side: tiles } : tiles;
      const topTile = t.top || t.side;
      const bottomTile = t.bottom || t.under || t.shade || t.side || t.back || t.front || t.top;
      const frontTile = t.front || t.side;
      const backTile = t.back || t.shade || t.side;
      const rightTile = t.right || t.side;
      const leftTile = t.left || t.shade || t.side;
      const flags = opts.flags !== undefined ? opts.flags : 5;
      const baseAo = opts.noAo ? 1.0 : (opts.ao !== undefined ? opts.ao : (y0 <= 0.25 ? 0.86 : 0.94));
      const sideAo = [baseAo, baseAo, 1, 1];
      if (!opts.noTop) {
        this.addQuad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], topTile, lid, { flags });
      }
      if (opts.withBottom) {
        this.addQuad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], bottomTile, lid, { ao: [0.85, 0.85, 0.85, 0.85], flags });
      }
      if (!opts.noFront) {
        this.addQuad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], frontTile, lid, { ao: sideAo, flags });
      }
      if (!opts.noBack) {
        this.addQuad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], backTile, lid, { ao: sideAo, flags });
      }
      if (!opts.noRight) {
        this.addQuad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], rightTile, lid, { ao: sideAo, flags });
      }
      if (!opts.noLeft) {
        this.addQuad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], leftTile, lid, { ao: sideAo, flags });
      }
    }

    addPitchedRoof(cx, baseY, cz, w, roofH, d, axis = "x", lid = 0, wallTile = "lingnanWall") {
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const z0 = cz - d / 2, z1 = cz + d / 2;
      const y0 = baseY, yTop = baseY + roofH;
      // Uniform world-space roof tile density matching map-top.png (~1 tile repeat per 9.5 units)
      const repX = Math.max(1, w / 9.2);
      const repZ = Math.max(1, d / 9.2);

      if (axis === "x") {
        const r0 = [x0, yTop, cz], r1 = [x1, yTop, cz];
        const c0 = [x0, y0, z0], c1 = [x1, y0, z0], c2 = [x1, y0, z1], c3 = [x0, y0, z1];
        this.addQuad(c1, c0, r0, r1, "roofTile", lid, { uRep: repX, vRep: Math.max(0.7, d / 7.5), ao: [0.92, 0.92, 1, 1] });
        this.addQuad(c3, c2, r1, r0, "roofTile", lid, { uRep: repX, vRep: Math.max(0.7, d / 7.5), ao: [0.92, 0.92, 1, 1] });
        this.addTri(c0, c3, r0, [0, 1], [1, 1], [0.5, 0.3], wallTile, lid, [0.94, 0.94, 1], 0);
        this.addTri(c2, c1, r1, [0, 1], [1, 1], [0.5, 0.3], wallTile, lid, [0.94, 0.94, 1], 0);
        this.addTexturedBox(cx, yTop - 0.1, cz, w + 0.16, 0.34, 0.42, "ridgeCap", lid, { noAo: true });
      } else {
        const r0 = [cx, yTop, z0], r1 = [cx, yTop, z1];
        const c0 = [x0, y0, z0], c1 = [x1, y0, z0], c2 = [x1, y0, z1], c3 = [x0, y0, z1];
        this.addQuad(c0, c3, r1, r0, "roofTile", lid, { uRep: repZ, vRep: Math.max(0.7, w / 7.5), ao: [0.92, 0.92, 1, 1] });
        this.addQuad(c2, c1, r0, r1, "roofTile", lid, { uRep: repZ, vRep: Math.max(0.7, w / 7.5), ao: [0.92, 0.92, 1, 1] });
        this.addTri(c1, c0, r0, [0, 1], [1, 1], [0.5, 0.3], wallTile, lid, [0.94, 0.94, 1], 0);
        this.addTri(c3, c2, r1, [0, 1], [1, 1], [0.5, 0.3], wallTile, lid, [0.94, 0.94, 1], 0);
        this.addTexturedBox(cx, yTop - 0.1, cz, 0.42, 0.34, d + 0.16, "ridgeCap", lid, { noAo: true });
      }
    }

    addLingnanHouse(cx, cz, w, d, wallH, roofH, axis, lid = 0) {
      this.addTexturedBox(cx, 0, cz, w, wallH, d, {
        top: "ridgeCap", side: "lingnanWall"
      }, lid, { shadow: true, uRepW: Math.max(1, Math.round(w / 6)), uRepD: Math.max(1, Math.round(d / 6)), noTop: true });
      this.addPitchedRoof(cx, wallH, cz, w + 0.4, roofH, d + 0.4, axis, lid, "lingnanWall");
    }

    // Crisp pixel-art Sino-Western Qilou building with real scalloped Baroque parapet gable (alpha-cutout top!)
    addPixelQilou(cx, cz, w, d, height, facing, facadeTile, lid = 0, opts = {}) {
      const gableH = 2.0;
      const bodyH = height;
      const bays = opts.bays || 1;
      this.addGroundShadow(cx, cz, w, d, bodyH + gableH, 0.18);

      // Solid architectural volume with UV-mapped pixel-art facade (rows 6..36 of the qilou tile)
      const sideTile = opts.sideTile || "lingnanWall";
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const z0 = cz - d / 2, z1 = cz + d / 2;

      // Build recessed 3D colonnade depth + overhanging upper story
      const bodyV0 = 6 / 36;
      const bodyVH = 30 / 36;

      if (facing === "+x") {
        // Main body box
        this.addQuad([x1, 0, z1], [x1, 0, z0], [x1, bodyH, z0], [x1, bodyH, z1], facadeTile, lid, {
          u0: 0, uRep: bays, v0: bodyV0, vRep: bodyVH, ao: [0.85, 0.85, 1, 1]
        });
        this.addQuad([x0, 0, z0], [x0, 0, z1], [x0, bodyH, z1], [x0, bodyH, z0], sideTile, lid, { uRep: bays, ao: [0.84, 0.84, 1, 1] });
        const southIsQilou = !opts.southTile || opts.southTile.startsWith("qilou");
        this.addQuad([x0, 0, z1], [x1, 0, z1], [x1, bodyH, z1], [x0, bodyH, z1], opts.southTile || facadeTile, lid, {
          u0: 0, uRep: 1, v0: southIsQilou ? bodyV0 : 0, vRep: southIsQilou ? bodyVH : 1, ao: [0.85, 0.85, 1, 1]
        });
        this.addQuad([x1, 0, z0], [x0, 0, z0], [x0, bodyH, z0], [x1, bodyH, z0], sideTile, lid, { uRep: 1, ao: [0.84, 0.84, 1, 1] });
        // Scalloped Baroque parapet gable panel rising on +X front (alpha-cutout top rows 0..6!)
        this.addQuad([x1 + 0.06, bodyH - 0.1, z1], [x1 + 0.06, bodyH - 0.1, z0], [x1 + 0.06, bodyH + gableH, z0], [x1 + 0.06, bodyH + gableH, z1], facadeTile, lid, {
          u0: 0, uRep: bays, v0: 0, vRep: bodyV0 + 0.02, flags: 3, doubleSided: true
        });
        // Crisp parapet coping ledge along side & back
        this.addTexturedBox(cx - 0.25, bodyH - 0.15, cz, w - 0.5, 0.35, d, "parapetTop", lid, { noAo: true });
        // Pitched fluted blue-grey tile roof tucked behind scalloped gable
        this.addPitchedRoof(cx - 0.4, bodyH + 0.1, cz, w - 0.9, 1.7, d - 0.3, "z", lid, sideTile);
      } else {
        // Facing +Z (south street/plaza)
        this.addQuad([x0, 0, z1], [x1, 0, z1], [x1, bodyH, z1], [x0, bodyH, z1], facadeTile, lid, {
          u0: 0, uRep: bays, v0: bodyV0, vRep: bodyVH, ao: [0.85, 0.85, 1, 1]
        });
        this.addQuad([x1, 0, z0], [x0, 0, z0], [x0, bodyH, z0], [x1, bodyH, z0], sideTile, lid, { uRep: bays, ao: [0.84, 0.84, 1, 1] });
        const eastIsQilou = !opts.eastTile || opts.eastTile.startsWith("qilou");
        this.addQuad([x1, 0, z1], [x1, 0, z0], [x1, bodyH, z0], [x1, bodyH, z1], opts.eastTile || facadeTile, lid, {
          u0: 0, uRep: 1, v0: eastIsQilou ? bodyV0 : 0, vRep: eastIsQilou ? bodyVH : 1, ao: [0.85, 0.85, 1, 1]
        });
        this.addQuad([x0, 0, z0], [x0, 0, z1], [x0, bodyH, z1], [x0, bodyH, z0], sideTile, lid, { uRep: 1, ao: [0.84, 0.84, 1, 1] });
        // Scalloped parapet gable on +Z front
        this.addQuad([x0, bodyH - 0.1, z1 + 0.06], [x1, bodyH - 0.1, z1 + 0.06], [x1, bodyH + gableH, z1 + 0.06], [x0, bodyH + gableH, z1 + 0.06], facadeTile, lid, {
          u0: 0, uRep: bays, v0: 0, vRep: bodyV0 + 0.02, flags: 3, doubleSided: true
        });
        this.addTexturedBox(cx, bodyH - 0.15, cz - 0.25, w, 0.35, d - 0.5, "parapetTop", lid, { noAo: true });
        this.addPitchedRoof(cx, bodyH + 0.1, cz - 0.4, w - 0.3, 1.7, d - 0.9, "x", lid, sideTile);
      }
    }

    // Volumetric pixel-art tree (organic top-down + rich 45-degree foliage silhouette, zero boxy CAD feel!)
    addPixelTree(cx, cz, scale = 1.0, lid = 0, isBanyan = false) {
      const canopyR = (isBanyan ? 4.4 : 2.15) * scale;
      const trunkH = (isBanyan ? 2.8 : 1.5) * scale;
      const canopyH = (isBanyan ? 5.6 : 3.4) * scale;
      this.addGroundShadow(cx, cz, canopyR * 2.1, canopyR * 1.9, trunkH + canopyH * 0.7, 0.18);

      // 3D trunk core
      this.addTexturedBox(cx, 0, cz, (isBanyan ? 1.5 : 0.55) * scale, trunkH, (isBanyan ? 1.3 : 0.55) * scale, "woodBoat", lid);

      // Horizontal layered alpha-cutout pixel leaf tiers (perfect top-down map-top.png readability + stepped 3D volume!)
      const topSprite = isBanyan ? "banyanTop" : "treeCluster";
      const tiers = isBanyan
        ? [
          [trunkH + 0.8, canopyR * 1.05, 0, 0],
          [trunkH + 2.1, canopyR * 0.95, -0.35, -0.2],
          [trunkH + 3.4, canopyR * 0.78, 0.25, 0.15],
          [trunkH + 4.5, canopyR * 0.55, -0.1, -0.1]
        ]
        : [
          [trunkH + 0.45 * scale, canopyR * 1.0, 0, 0],
          [trunkH + 1.45 * scale, canopyR * 0.82, -0.18 * scale, -0.12 * scale],
          [trunkH + 2.35 * scale, canopyR * 0.56, 0.12 * scale, 0.1 * scale]
        ];
      for (const [ty, rad, ox, oz] of tiers) {
        this.addQuad(
          [cx + ox - rad, ty, cz + oz - rad],
          [cx + ox - rad, ty, cz + oz + rad],
          [cx + ox + rad, ty, cz + oz + rad],
          [cx + ox + rad, ty, cz + oz - rad],
          topSprite, lid, { flags: 3, doubleSided: true }
        );
      }

      // Crossed vertical/sloped foliage planes (gives lush full pixel-art crown from 45° oblique!)
      const sideSprite = isBanyan ? "banyanSide" : "treeCluster";
      const yBot = isBanyan ? 0.15 : trunkH * 0.75;
      const yTop = trunkH + canopyH;
      const wHalf = canopyR * (isBanyan ? 1.15 : 0.98);
      // South-facing plane (+Z)
      this.addQuad(
        [cx - wHalf, yBot, cz], [cx + wHalf, yBot, cz],
        [cx + wHalf, yTop, cz], [cx - wHalf, yTop, cz],
        sideSprite, lid, { flags: 3, doubleSided: true }
      );
      // East-facing plane (+X)
      this.addQuad(
        [cx, yBot, cz + wHalf], [cx, yBot, cz - wHalf],
        [cx, yTop, cz - wHalf], [cx, yTop, cz + wHalf],
        sideSprite, lid, { flags: 3, doubleSided: true }
      );
    }

    addPedestrian(cx, cz, tile = "pedestrianA") {
      const halfW = 0.75;
      const height = 2.05;
      this.addGroundShadow(cx, cz, 0.9, 0.9, 1.4, 0.14);
      this.addQuad(
        [cx - halfW, 0.06, cz], [cx + halfW, 0.06, cz],
        [cx + halfW, height, cz], [cx - halfW, height, cz],
        tile, 0, { flags: 3, doubleSided: true }
      );
      this.addQuad(
        [cx, 0.06, cz + halfW], [cx, 0.06, cz - halfW],
        [cx, height, cz - halfW], [cx, height, cz + halfW],
        tile, 0, { flags: 3, doubleSided: true }
      );
    }

    addUmbrella(cx, cz, lid = 0) {
      this.addGroundShadow(cx, cz, 2.7, 2.7, 2.4, 0.15);
      this.addTexturedBox(cx, 0, cz, 0.22, 2.1, 0.22, "woodBoat", lid);
      this.addTexturedBox(cx, 0.85, cz, 1.25, 0.18, 1.25, "woodBoat", lid);
      const r = 1.65;
      const y0 = 2.1, y1 = 2.85;
      const apex = [cx, y1, cz];
      const c0 = [cx - r, y0, cz - r], c1 = [cx + r, y0, cz - r], c2 = [cx + r, y0, cz + r], c3 = [cx - r, y0, cz + r];
      this.addTri(c0, c1, apex, [0, 1], [1, 1], [0.5, 0], "umbrella", lid);
      this.addTri(c1, c2, apex, [0, 1], [1, 1], [0.5, 0], "umbrella", lid);
      this.addTri(c2, c3, apex, [0, 1], [1, 1], [0.5, 0], "umbrella", lid);
      this.addTri(c3, c0, apex, [0, 1], [1, 1], [0.5, 0], "umbrella", lid);
    }

    addMarketStall(cx, cz, awningTile, lid = 0) {
      this.addGroundShadow(cx, cz, 3.0, 2.6, 2.6, 0.15);
      this.addTexturedBox(cx, 0, cz, 2.4, 0.9, 1.7, "woodBoat", lid);
      for (const [px, pz] of [[-1.05, -0.7], [1.05, -0.7], [-1.05, 0.7], [1.05, 0.7]]) {
        this.addTexturedBox(cx + px, 0.9, cz + pz, 0.16, 1.4, 0.16, "woodBoat", lid);
      }
      const w = 3.0, d = 2.5, y0 = 2.25, y1 = 2.95;
      this.addQuad([cx - w / 2, y0, cz + d / 2], [cx + w / 2, y0, cz + d / 2], [cx + w / 2, y1, cz], [cx - w / 2, y1, cz], awningTile, lid);
      this.addQuad([cx + w / 2, y0, cz - d / 2], [cx - w / 2, y0, cz - d / 2], [cx - w / 2, y1, cz], [cx + w / 2, y1, cz], awningTile, lid);
    }

    addCar(cx, cz, carTile, lid = 0) {
      this.addGroundShadow(cx, cz, 3.9, 2.0, 1.5, 0.16);
      this.addTexturedBox(cx, 0.25, cz, 3.6, 0.78, 1.7, carTile, lid, { noAo: true });
      this.addTexturedBox(cx - 0.15, 1.03, cz, 2.0, 0.62, 1.42, carTile, lid, { noAo: true });
    }

    addSampleBlockyRoof(cx, baseY, cz, w, roofH, d, axis = "x", lid = 0, wallTile = "sampleSideGrey", steppedEnds = {}) {
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const z0 = cz - d / 2, z1 = cz + d / 2;
      const y0 = baseY, yTop = baseY + roofH;
      if (axis === "x") {
        const r0 = [x0, yTop, cz], r1 = [x1, yTop, cz];
        const c0 = [x0, y0, z0], c1 = [x1, y0, z0], c2 = [x1, y0, z1], c3 = [x0, y0, z1];
        this.addQuad(c1, c0, r0, r1, "sampleRoofTile", lid, { uRep: 1, vRep: 1, ao: [0.93, 0.93, 1, 1], flags: 4 });
        this.addQuad(c3, c2, r1, r0, "sampleRoofTile", lid, { uRep: 1, vRep: 1, ao: [0.93, 0.93, 1, 1], flags: 4 });
        this.addTri(c0, c3, r0, [0, 1], [1, 1], [0.5, 0.25], wallTile, lid, [0.94, 0.94, 1], 0);
        this.addTri(c2, c1, r1, [0, 1], [1, 1], [0.5, 0.25], wallTile, lid, [0.94, 0.94, 1], 0);
        this.addTexturedBox(cx, yTop - 0.02, cz, w + 0.16, 0.32, 0.56, "sampleRidge", lid, { noAo: true, flags: 4 });
        const addSteppedParapetEdge = edgeZ => {
          this.addTexturedBox(cx, y0 - 0.04, edgeZ, w + 0.12, 0.36, 0.36, "sampleParapet", lid, { noAo: true, flags: 4 });
        };
        if (steppedEnds.north) addSteppedParapetEdge(z0 + 0.06);
        if (steppedEnds.south) addSteppedParapetEdge(z1 - 0.06);
        if (steppedEnds.west) {
          this.addTexturedBox(x0 + 0.14, y0, cz, 0.36, roofH * 0.48, d * 0.96, "sampleParapet", lid, { noAo: true, flags: 4 });
          this.addTexturedBox(x0 + 0.14, y0 + roofH * 0.44, cz, 0.36, roofH * 0.42, d * 0.56, "sampleParapet", lid, { noAo: true, flags: 4 });
          this.addTexturedBox(x0 + 0.14, y0 + roofH * 0.82, cz, 0.36, 0.32, d * 0.26, "sampleParapet", lid, { noAo: true, flags: 4 });
        }
      } else {
        const r0 = [cx, yTop, z0], r1 = [cx, yTop, z1];
        const c0 = [x0, y0, z0], c1 = [x1, y0, z0], c2 = [x1, y0, z1], c3 = [x0, y0, z1];
        this.addQuad(c0, c3, r1, r0, "sampleRoofTile", lid, { uRep: 1, vRep: 1, ao: [0.93, 0.93, 1, 1], flags: 4 });
        this.addQuad(c2, c1, r0, r1, "sampleRoofTile", lid, { uRep: 1, vRep: 1, ao: [0.93, 0.93, 1, 1], flags: 4 });
        this.addTri(c1, c0, r0, [0, 1], [1, 1], [0.5, 0.25], wallTile, lid, [0.94, 0.94, 1], 0);
        this.addTri(c3, c2, r1, [0, 1], [1, 1], [0.5, 0.25], wallTile, lid, [0.94, 0.94, 1], 0);
        this.addTexturedBox(cx, yTop - 0.02, cz, 0.56, 0.32, d + 0.16, "sampleRidge", lid, { noAo: true, flags: 4 });
        const addSteppedGableCap = edgeZ => {
          this.addTexturedBox(cx, y0, edgeZ, w * 0.98, roofH * 0.46, 0.36, "sampleParapet", lid, { noAo: true, flags: 4 });
          this.addTexturedBox(cx, y0 + roofH * 0.42, edgeZ, w * 0.62, roofH * 0.42, 0.36, "sampleParapet", lid, { noAo: true, flags: 4 });
          this.addTexturedBox(cx, y0 + roofH * 0.80, edgeZ, w * 0.28, 0.32, 0.36, "sampleParapet", lid, { noAo: true, flags: 4 });
        };
        if (steppedEnds.north) addSteppedGableCap(z0 + 0.1);
        if (steppedEnds.south) addSteppedGableCap(z1 - 0.1);
      }
    }

    addSampleLantern3D(cx, yTop, cz, lid = 6) {
      this.addTexturedBox(cx, yTop - 0.18, cz, 0.08, 0.18, 0.08, "woodBoat", lid, { noAo: true });
      this.addTexturedBox(cx, yTop - 0.30, cz, 0.44, 0.12, 0.44, "woodBoat", lid, { noAo: true });
      this.addTexturedBox(cx, yTop - 1.10, cz, 0.78, 0.80, 0.78, "sampleLantern", lid, { noAo: true });
      this.addTexturedBox(cx, yTop - 1.22, cz, 0.40, 0.12, 0.40, "woodBoat", lid, { noAo: true });
      this.addTexturedBox(cx, yTop - 1.56, cz, 0.16, 0.30, 0.16, "sampleLantern", lid, { noAo: true });
    }

    addSampleUmbrellaTable(cx, cz, lid = 0) {
      this.addGroundShadow(cx, cz, 3.3, 3.3, 2.8, 0.22);
      this.addTexturedBox(cx, 0, cz, 0.22, 2.25, 0.22, "woodBoat", lid);
      this.addTexturedBox(cx, 0.88, cz, 1.38, 0.18, 1.38, "woodBoat", lid);
      for (const [ox, oz] of [[-1.02, 0], [1.02, 0], [0, -1.02], [0, 1.02]]) {
        this.addTexturedBox(cx + ox, 0, cz + oz, 0.46, 0.52, 0.46, "woodBoat", lid);
        this.addTexturedBox(cx + ox * 1.18, 0.52, cz + oz * 1.18, 0.16, 0.44, 0.16, "woodBoat", lid);
      }
      const radius = 1.82;
      const y0 = 2.15, y1 = 2.98;
      const apex = [cx, y1, cz];
      const c0 = [cx - radius, y0, cz - radius], c1 = [cx + radius, y0, cz - radius];
      const c2 = [cx + radius, y0, cz + radius], c3 = [cx - radius, y0, cz + radius];
      this.addTri(c0, c1, apex, [0, 1], [1, 1], [0.5, 0], "umbrella", lid);
      this.addTri(c1, c2, apex, [0, 1], [1, 1], [0.5, 0], "umbrella", lid);
      this.addTri(c2, c3, apex, [0, 1], [1, 1], [0.5, 0], "umbrella", lid);
      this.addTri(c3, c0, apex, [0, 1], [1, 1], [0.5, 0], "umbrella", lid);
    }

    addSampleTreeWithShadow(cx, cz, scale = 1.0, lid = 0) {
      this.addGroundShadow(cx, cz, 3.6 * scale, 3.2 * scale, 5.4 * scale, 0.24);
      this.addPixelTree(cx, cz, scale, lid, false);
    }

    addSampleArcadeShop(cfg) {
      const {
        x0, x1, z0, z1, arcadeH, bodyH, gableH, roofH,
        upperTile, gableTile, northTile = "sampleSideGrey", southTile = "sampleSideGrey",
        archCount = 2, lanterns = false, pillarOrnaments = false,
        roofAxis = "x", steppedEnds = { north: true, south: true, west: true },
        cornerSouth = null,
        lid = 6
      } = cfg;
      const width = x1 - x0;
      const depth = z1 - z0;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const recess = 1.72;
      const xBack = x1 - recess;

      this.addGroundShadow(cx, cz, width, depth, bodyH + gableH * 0.7, 0.19);

      const coreW = xBack - x0;
      const coreCx = (x0 + xBack) / 2;
      if (cornerSouth) {
        const zBack = z1 - recess;
        const coreD = zBack - z0;
        const coreCz = (z0 + zBack) / 2;
        this.addTexturedBox(coreCx, 0, coreCz, coreW, arcadeH, coreD, {
          top: "sampleCavity",
          right: "sampleCavity",
          left: "lingnanWall",
          front: "sampleCavity",
          back: northTile
        }, lid, { noTop: true, rightURep: archCount, rightVRep: 1 });
        this.addQuad([xBack, arcadeH - 0.04, z0], [x1, arcadeH - 0.04, z0], [x1, arcadeH - 0.04, z1], [xBack, arcadeH - 0.04, z1], "sampleCavity", lid, { doubleSided: true });
        this.addQuad([x0, arcadeH - 0.04, zBack], [xBack, arcadeH - 0.04, zBack], [xBack, arcadeH - 0.04, z1], [x0, arcadeH - 0.04, z1], "sampleCavity", lid, { doubleSided: true });
        this.addQuad([xBack, 0, z0 + 0.04], [x1, 0, z0 + 0.04], [x1, arcadeH, z0 + 0.04], [xBack, arcadeH, z0 + 0.04], northTile, lid, { doubleSided: true });
        this.addQuad([x0 + 0.04, 0, zBack], [x0 + 0.04, 0, z1], [x0 + 0.04, arcadeH, z1], [x0 + 0.04, arcadeH, zBack], cornerSouth.westEndTile || southTile, lid, { doubleSided: true });
      } else {
        this.addTexturedBox(coreCx, 0, cz, coreW, arcadeH, depth, {
          top: "sampleCavity",
          right: "sampleCavity",
          left: "lingnanWall",
          front: southTile,
          back: northTile
        }, lid, { noTop: true, rightURep: archCount, rightVRep: 1 });
        this.addQuad([xBack, arcadeH - 0.04, z0], [x1, arcadeH - 0.04, z0], [x1, arcadeH - 0.04, z1], [xBack, arcadeH - 0.04, z1], "sampleCavity", lid, { doubleSided: true });
        this.addQuad([xBack, 0, z0 + 0.04], [x1, 0, z0 + 0.04], [x1, arcadeH, z0 + 0.04], [xBack, arcadeH, z0 + 0.04], northTile, lid, { doubleSided: true });
        this.addQuad([xBack, 0, z1 - 0.04], [x1, 0, z1 - 0.04], [x1, arcadeH, z1 - 0.04], [xBack, arcadeH, z1 - 0.04], southTile, lid, { doubleSided: true });
      }

      const bayLen = depth / archCount;
      for (let colIdx = 0; colIdx <= archCount; colIdx += 1) {
        const pz = z0 + colIdx * bayLen;
        const colD = (colIdx === 0 || colIdx === archCount) ? 0.44 : 0.42;
        const colZ = colIdx === 0 ? pz + colD / 2 : (colIdx === archCount ? pz - colD / 2 : pz);
        this.addTexturedBox(x1 - 0.24, 0, colZ, 0.48, arcadeH, colD, "sampleParapet", lid, { noAo: false, flags: 4 });
      }
      for (let bayIdx = 0; bayIdx < archCount; bayIdx += 1) {
        const bz0 = z0 + bayIdx * bayLen;
        const bz1 = bz0 + bayLen;
        this.addQuad([x1 + 0.02, 0, bz1], [x1 + 0.02, 0, bz0], [x1 + 0.02, arcadeH, bz0], [x1 + 0.02, arcadeH, bz1], "sampleArcadeArch", lid, { flags: 3, doubleSided: true });
        this.addQuad([x1 - 0.36, 0, bz1], [x1 - 0.36, 0, bz0], [x1 - 0.36, arcadeH, bz0], [x1 - 0.36, arcadeH, bz1], "sampleArcadeArch", lid, { flags: 3, doubleSided: true });
        if (lanterns) {
          this.addSampleLantern3D(x1 + 0.08, arcadeH - 0.56, (bz0 + bz1) / 2, lid);
        }
      }
      if (pillarOrnaments) {
        for (let colIdx = 1; colIdx < archCount; colIdx += 1) {
          const pz = z0 + colIdx * bayLen;
          this.addTexturedBox(x1 + 0.10, arcadeH - 1.12, pz, 0.24, 0.30, 0.24, "sampleLantern", lid, { noAo: true });
        }
      }
      if (cornerSouth) {
        const sArchCount = cornerSouth.archCount || 3;
        const sBayLen = width / sArchCount;
        for (let colIdx = 0; colIdx < sArchCount; colIdx += 1) {
          const px = x0 + colIdx * sBayLen;
          const colW = colIdx === 0 ? 0.44 : 0.42;
          const colX = colIdx === 0 ? px + colW / 2 : px;
          this.addTexturedBox(colX, 0, z1 - 0.24, colW, arcadeH, 0.48, "sampleParapet", lid, { noAo: false, flags: 4 });
        }
        for (let bayIdx = 0; bayIdx < sArchCount; bayIdx += 1) {
          const bx0 = x0 + bayIdx * sBayLen;
          const bx1 = bx0 + sBayLen;
          this.addQuad([bx0, 0, z1 + 0.02], [bx1, 0, z1 + 0.02], [bx1, arcadeH, z1 + 0.02], [bx0, arcadeH, z1 + 0.02], "sampleArcadeArch", lid, { flags: 3, doubleSided: true });
          this.addQuad([bx0, 0, z1 - 0.36], [bx1, 0, z1 - 0.36], [bx1, arcadeH, z1 - 0.36], [bx0, arcadeH, z1 - 0.36], "sampleArcadeArch", lid, { flags: 3, doubleSided: true });
        }
      }

      this.addQuad([x1, arcadeH, z1], [x1, arcadeH, z0], [x1, bodyH, z0], [x1, bodyH, z1], upperTile, lid, { ao: [0.92, 0.92, 1, 1] });
      this.addQuad([x0, arcadeH, z0], [x0, arcadeH, z1], [x0, bodyH, z1], [x0, bodyH, z0], "lingnanWall", lid, { ao: [0.88, 0.88, 1, 1] });
      this.addQuad([x0, arcadeH, z1], [x1, arcadeH, z1], [x1, bodyH, z1], [x0, bodyH, z1], cornerSouth ? cornerSouth.upperTile : southTile, lid, { ao: [0.92, 0.92, 1, 1] });
      this.addQuad([x1, arcadeH, z0], [x0, arcadeH, z0], [x0, bodyH, z0], [x1, bodyH, z0], northTile, lid, { ao: [0.9, 0.9, 1, 1] });
      this.addTexturedBox(cx - 0.14, bodyH - 0.14, cz, width - 0.28, 0.3, depth, "sampleParapet", lid, { noAo: true, flags: 4 });

      this.addQuad([x1 + 0.06, bodyH - 0.12, z1], [x1 + 0.06, bodyH - 0.12, z0], [x1 + 0.06, bodyH + gableH, z0], [x1 + 0.06, bodyH + gableH, z1], gableTile, lid, { flags: 3, doubleSided: true });
      this.addQuad([x1 - 0.16, bodyH - 0.12, z1], [x1 - 0.16, bodyH - 0.12, z0], [x1 - 0.16, bodyH + gableH, z0], [x1 - 0.16, bodyH + gableH, z1], gableTile, lid, { flags: 3, doubleSided: true });

      if (cornerSouth && cornerSouth.gableTile) {
        const sGableH = cornerSouth.gableH || gableH;
        this.addQuad([x0, bodyH - 0.12, z1 + 0.06], [x1, bodyH - 0.12, z1 + 0.06], [x1, bodyH + sGableH, z1 + 0.06], [x0, bodyH + sGableH, z1 + 0.06], cornerSouth.gableTile, lid, { flags: 3, doubleSided: true });
        this.addQuad([x0, bodyH - 0.12, z1 - 0.16], [x1, bodyH - 0.12, z1 - 0.16], [x1, bodyH + sGableH, z1 - 0.16], [x0, bodyH + sGableH, z1 - 0.16], cornerSouth.gableTile, lid, { flags: 3, doubleSided: true });
      }

      const roofInsetZ = cornerSouth ? 0.56 : 0.24;
      const roofCz = cornerSouth ? (cz - 0.18) : cz;
      this.addSampleBlockyRoof(cx - 0.35, bodyH + 0.08, roofCz, width - 0.88, roofH, depth - roofInsetZ, roofAxis, lid, northTile, steppedEnds);
    }

    addCoarseVoxelRoof(cx, baseY, cz, w, roofH, d, axis, lid, wallPal, steppedEnds, V, recordMeasure = false) {
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const z0 = cz - d / 2, z1 = cz + d / 2;
      const steps = V >= 0.42 ? 3 : Math.max(4, Math.round(roofH / (V * 1.12)));
      const stepH = roofH / steps;
      const ridgeW = Math.max(0.54, Number((V * 1.55).toFixed(3)));
      const ridgeH = Math.max(0.32, Number((V * 0.90).toFixed(3)));
      const parapetT = Math.max(0.38, Number((V * 1.08).toFixed(3)));
      const ribLen = Math.max(0.85, V * 2.05);

      if (axis === "x") {
        const halfSpan = Math.max(0.3, (d - ridgeW) / 2);
        for (let s = 0; s < steps; s += 1) {
          const sy0 = baseY + s * stepH;
          const sy1 = baseY + (s + 1) * stepH;
          const inset = (s / steps) * halfSpan;
          const sz0 = z0 + inset;
          const sz1 = z1 - inset;
          const segs = Math.max(3, Math.round(w / ribLen));
          const segW = w / segs;
          for (let segIdx = 0; segIdx < segs; segIdx += 1) {
            const sx0 = x0 + segIdx * segW;
            const sx1 = sx0 + segW;
            const isAlt = (segIdx + s) % 2 === 0;
            const topTile = isAlt ? "vxRoofLight" : "vxRoofMid";
            const riserTile = isAlt ? "vxRoofDark" : "vxRoofMid";
            this.addVoxelBox(sx0, sy0, sz0, sx1, sy1, sz1, {
              top: topTile,
              front: riserTile,
              back: "vxRoofDark",
              left: wallPal.shade,
              right: wallPal.mid
            }, lid, { noAo: true });
          }
        }
        const rY0 = baseY + roofH - 0.04;
        this.addVoxelBox(x0 - 0.08, rY0, cz - ridgeW / 2, x1 + 0.08, rY0 + ridgeH, cz + ridgeW / 2, {
          top: "vxRidgeTop", front: "vxRidgeSide", back: "vxRidgeSide", left: "vxRidgeSide", right: "vxRidgeSide"
        }, lid, { noAo: true });

        if (steppedEnds.north) {
          this.addVoxelBox(x0 - 0.04, baseY - 0.05, z0 - 0.02, x1 + 0.04, baseY + stepH * 0.85, z0 + parapetT, {
            top: "vxTrimTop", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront"
          }, lid, { noAo: true });
        }
        if (steppedEnds.south) {
          this.addVoxelBox(x0 - 0.04, baseY - 0.05, z1 - parapetT, x1 + 0.04, baseY + stepH * 0.85, z1 + 0.02, {
            top: "vxTrimTop", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront"
          }, lid, { noAo: true });
        }
        if (steppedEnds.west) {
          for (let s = 0; s < steps; s += 1) {
            const sy0 = baseY + s * stepH;
            const sy1 = baseY + (s + 1) * stepH + V * 0.35;
            const inset = (s / steps) * halfSpan;
            this.addVoxelBox(x0 - 0.04, sy0, z0 + inset, x0 + parapetT, sy1, z1 - inset, {
              top: "vxTrimTop", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront"
            }, lid, { noAo: true });
          }
          this.addVoxelBox(x0 - 0.06, rY0, cz - ridgeW * 0.62, x0 + parapetT + 0.04, rY0 + ridgeH + V * 0.28, cz + ridgeW * 0.62, {
            top: "vxTrimTop", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront"
          }, lid, { noAo: true });
        }
        if (recordMeasure) {
          this.addMeasureSegment("roofStepH", "屋面瓦阶高", [cx, baseY, z1], [cx, baseY + stepH, z1], stepH, `${steps}阶实体体素瓦坡`);
          this.addMeasureSegment("ridgeCapW", "屋脊压顶宽", [cx, rY0 + ridgeH, cz - ridgeW / 2], [cx, rY0 + ridgeH, cz + ridgeW / 2], ridgeW, "屋脊实体压顶块");
        }
      } else {
        const halfSpan = Math.max(0.3, (w - ridgeW) / 2);
        for (let s = 0; s < steps; s += 1) {
          const sy0 = baseY + s * stepH;
          const sy1 = baseY + (s + 1) * stepH;
          const inset = (s / steps) * halfSpan;
          const sx0 = x0 + inset;
          const sx1 = x1 - inset;
          const segs = Math.max(3, Math.round(d / ribLen));
          const segD = d / segs;
          for (let segIdx = 0; segIdx < segs; segIdx += 1) {
            const sz0 = z0 + segIdx * segD;
            const sz1 = sz0 + segD;
            const isAlt = (segIdx + s) % 2 === 0;
            const topTile = isAlt ? "vxRoofLight" : "vxRoofMid";
            const riserTile = isAlt ? "vxRoofDark" : "vxRoofMid";
            this.addVoxelBox(sx0, sy0, sz0, sx1, sy1, sz1, {
              top: topTile,
              right: riserTile,
              left: "vxRoofDark",
              front: wallPal.mid,
              back: wallPal.shade
            }, lid, { noAo: true });
          }
        }
        const rY0 = baseY + roofH - 0.04;
        this.addVoxelBox(cx - ridgeW / 2, rY0, z0 - 0.08, cx + ridgeW / 2, rY0 + ridgeH, z1 + 0.08, {
          top: "vxRidgeTop", front: "vxRidgeSide", back: "vxRidgeSide", left: "vxRidgeSide", right: "vxRidgeSide"
        }, lid, { noAo: true });

        const addZSteppedCap = edgeZ0 => {
          for (let s = 0; s < steps; s += 1) {
            const sy0 = baseY + s * stepH;
            const sy1 = baseY + (s + 1) * stepH + V * 0.35;
            const inset = (s / steps) * halfSpan;
            this.addVoxelBox(x0 + inset, sy0, edgeZ0, x1 - inset, sy1, edgeZ0 + parapetT, {
              top: "vxTrimTop", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront"
            }, lid, { noAo: true });
          }
          this.addVoxelBox(cx - ridgeW * 0.62, rY0, edgeZ0 - 0.02, cx + ridgeW * 0.62, rY0 + ridgeH + V * 0.28, edgeZ0 + parapetT + 0.02, {
            top: "vxTrimTop", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront"
          }, lid, { noAo: true });
        };
        if (steppedEnds.north) addZSteppedCap(z0 - 0.02);
        if (steppedEnds.south) addZSteppedCap(z1 - parapetT + 0.02);
      }
    }

    addCoarseVoxelLantern(cx, yTop, cz, lid, V, recordMeasure = false) {
      const rodW = Math.max(0.20, V * 0.56);
      const rodH = Math.max(0.20, V * 0.52);
      const capW = Math.max(0.46, V * 1.32);
      const capH = Math.max(0.18, V * 0.52);
      const bodyW = Math.min(1.04, Math.max(0.84, V * 2.12));
      const bodyH = Math.min(0.96, Math.max(0.80, V * 1.95));
      const coreW = Math.max(0.34, V * 0.96);
      const coreH = Math.max(0.42, bodyH * 0.56);
      const tasselW = Math.max(0.24, V * 0.72);
      const tasselH = Math.max(0.32, V * 0.84);

      let curY = yTop;
      this.addVoxelBox(cx - rodW / 2, curY - rodH, cz - rodW / 2, cx + rodW / 2, curY, cz + rodW / 2, "vxWoodDark", lid, { noAo: true });
      curY -= rodH;

      this.addVoxelBox(cx - capW / 2, curY - capH, cz - capW / 2, cx + capW / 2, curY, cz + capW / 2, {
        top: "vxLanternGold", front: "vxLanternGold", right: "vxLanternGold", back: "vxWoodDark", left: "vxWoodDark", bottom: "vxWoodDark"
      }, lid, { noAo: true, withBottom: true });
      curY -= capH;

      if (V < 0.42) {
        // Medium tier: crisp 3-step voxel silhouette
        const bandH = bodyH * 0.24;
        const midH = bodyH - bandH * 2;
        const shoulderW = bodyW * 0.78;
        this.addVoxelBox(cx - shoulderW / 2, curY - bandH, cz - shoulderW / 2, cx + shoulderW / 2, curY, cz + shoulderW / 2, {
          top: "vxLanternRed", front: "vxLanternRed", right: "vxLanternOrange", back: "vxLanternDeep", left: "vxLanternDeep"
        }, lid, { noAo: true });
        curY -= bandH;
        this.addVoxelBox(cx - bodyW / 2, curY - midH, cz - bodyW / 2, cx + bodyW / 2, curY, cz + bodyW / 2, {
          top: "vxLanternOrange", front: "vxLanternOrange", right: "vxLanternOrange", back: "vxLanternDeep", left: "vxLanternDeep", bottom: "vxLanternDeep"
        }, lid, { noAo: true, withBottom: true });
        const coreY0 = curY - midH + (midH - coreH * 0.78) / 2;
        const coreY1 = coreY0 + coreH * 0.78;
        this.addVoxelBox(cx + bodyW / 2 - 0.04, coreY0, cz - coreW / 2, cx + bodyW / 2 + V * 0.22, coreY1, cz + coreW / 2, {
          top: "vxLanternGold", front: "vxLanternGold", right: "vxLanternGold", back: "vxLanternOrange", left: "vxLanternOrange", bottom: "vxLanternOrange"
        }, lid, { noAo: true, withBottom: true });
        this.addVoxelBox(cx - coreW / 2, coreY0, cz + bodyW / 2 - 0.04, cx + coreW / 2, coreY1, cz + bodyW / 2 + V * 0.18, {
          top: "vxLanternGold", front: "vxLanternGold", right: "vxLanternGold", back: "vxLanternOrange", left: "vxLanternOrange", bottom: "vxLanternOrange"
        }, lid, { noAo: true, withBottom: true });
        curY -= midH;
        this.addVoxelBox(cx - shoulderW / 2, curY - bandH, cz - shoulderW / 2, cx + shoulderW / 2, curY, cz + shoulderW / 2, {
          top: "vxLanternRed", front: "vxLanternRed", right: "vxLanternRed", back: "vxLanternDeep", left: "vxLanternDeep", bottom: "vxLanternDeep"
        }, lid, { noAo: true, withBottom: true });
        curY -= bandH;
      } else {
        // Coarse tier: bold solid chunky voxel lantern cube + protruding gold glow block
        const bodyY0 = curY - bodyH;
        this.addVoxelBox(cx - bodyW / 2, bodyY0, cz - bodyW / 2, cx + bodyW / 2, curY, cz + bodyW / 2, {
          top: "vxLanternRed", front: "vxLanternOrange", right: "vxLanternOrange", back: "vxLanternDeep", left: "vxLanternDeep", bottom: "vxLanternDeep"
        }, lid, { noAo: true, withBottom: true });
        const coreY0 = bodyY0 + (bodyH - coreH) / 2;
        const coreY1 = coreY0 + coreH;
        this.addVoxelBox(cx + bodyW / 2 - 0.04, coreY0, cz - coreW / 2, cx + bodyW / 2 + V * 0.24, coreY1, cz + coreW / 2, {
          top: "vxLanternGold", front: "vxLanternGold", right: "vxLanternGold", back: "vxLanternOrange", left: "vxLanternOrange", bottom: "vxLanternOrange"
        }, lid, { noAo: true, withBottom: true });
        this.addVoxelBox(cx - coreW / 2, coreY0, cz + bodyW / 2 - 0.04, cx + coreW / 2, coreY1, cz + bodyW / 2 + V * 0.20, {
          top: "vxLanternGold", front: "vxLanternGold", right: "vxLanternGold", back: "vxLanternOrange", left: "vxLanternOrange", bottom: "vxLanternOrange"
        }, lid, { noAo: true, withBottom: true });
        curY = bodyY0;
      }

      this.addVoxelBox(cx - capW / 2, curY - capH, cz - capW / 2, cx + capW / 2, curY, cz + capW / 2, {
        top: "vxLanternGold", front: "vxLanternGold", right: "vxLanternGold", back: "vxWoodDark", left: "vxWoodDark", bottom: "vxWoodDark"
      }, lid, { noAo: true, withBottom: true });
      curY -= capH;

      this.addVoxelBox(cx - tasselW / 2, curY - tasselH, cz - tasselW / 2, cx + tasselW / 2, curY, cz + tasselW / 2, {
        top: "vxLanternRed", front: "vxLanternRed", right: "vxLanternRed", back: "vxLanternDeep", left: "vxLanternDeep", bottom: "vxLanternDeep"
      }, lid, { noAo: true, withBottom: true });

      if (recordMeasure) {
        const midY = yTop - rodH - capH - bodyH / 2;
        this.addMeasureSegment("lanternBodyW", "灯笼主体宽", [cx + bodyW / 2, midY, cz - bodyW / 2], [cx + bodyW / 2, midY, cz + bodyW / 2], bodyW, "实体红橙灯笼体块");
        this.addMeasureSegment("lanternCoreW", "灯笼高光芯宽", [cx + bodyW / 2 + V * 0.2, midY, cz - coreW / 2], [cx + bodyW / 2 + V * 0.2, midY, cz + coreW / 2], coreW, "灯笼正立面金黄亮块");
      }
    }

    addCoarseVoxelGable(faceAxis, fixedCoord, span0, span1, baseY, gableH, pal, style, lid, V, recordMeasure = false) {
      const span = span1 - span0;
      const center = (span0 + span1) / 2;
      const outDepth = V * 0.62;
      const inDepth = V * 0.58;
      const relief = V * 0.26;
      const borderW = Math.min(span * 0.16, Math.max(0.32, V * 0.96));

      const emitSlab = (s0, s1, y0, y1, outExtra, inExtra, tiles, withBottom = false) => {
        if (faceAxis === "x") {
          this.addVoxelBox(fixedCoord - inDepth - inExtra, y0, s0, fixedCoord + outDepth + outExtra, y1, s1, tiles, lid, { noAo: true, withBottom });
        } else {
          this.addVoxelBox(s0, y0, fixedCoord - inDepth - inExtra, s1, y1, fixedCoord + outDepth + outExtra, tiles, lid, { noAo: true, withBottom });
        }
      };

      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };
      const wallTiles = { top: pal.mid, front: pal.mid, right: pal.mid, back: pal.shade, left: pal.shade, bottom: pal.dark };

      const isTall = gableH >= 2.3;
      const numSteps = V >= 0.42 ? (isTall ? 4 : 3) : (isTall ? 5 : 4);
      const stepH = gableH / numSteps;
      let ratios;
      if (style === "steppedSemiMint") {
        ratios = numSteps === 3 ? [0.94, 0.66, 0.36] : [0.96, 0.76, 0.54, 0.30];
      } else if (style === "waveCoral") {
        ratios = numSteps === 3 ? [0.88, 0.56, 0.28] : [0.92, 0.68, 0.46, 0.24];
      } else {
        ratios = numSteps === 4 ? [0.96, 0.72, 0.48, 0.24] : [0.96, 0.78, 0.60, 0.40, 0.22];
      }

      // Corner finials / wave shoulders
      if (style === "waveCoral") {
        const shW = Math.min(span * 0.26, V * 2.1);
        const shH = stepH * 1.15;
        emitSlab(span0 + 0.04, span0 + shW, baseY, baseY + shH, 0.04, 0, trimTiles);
        emitSlab(span0 + 0.04 + borderW * 0.45, span0 + shW - borderW * 0.45, baseY, baseY + shH - V * 0.32, -relief, 0.02, wallTiles);
        emitSlab(span1 - shW, span1 - 0.04, baseY, baseY + shH, 0.04, 0, trimTiles);
        emitSlab(span1 - shW + borderW * 0.45, span1 - 0.04 - borderW * 0.45, baseY, baseY + shH - V * 0.32, -relief, 0.02, wallTiles);
      } else {
        const finW = Math.min(span * 0.16, Math.max(0.36, V * 1.05));
        const finH = Math.min(gableH * 0.42, stepH * 1.15);
        emitSlab(span0 + 0.02, span0 + finW, baseY, baseY + finH, 0.06, 0, trimTiles);
        emitSlab(span1 - finW, span1 - 0.02, baseY, baseY + finH, 0.06, 0, trimTiles);
      }

      let measuredStepW = 0;
      for (let i = 0; i < numSteps; i += 1) {
        const sy0 = baseY + i * stepH;
        const sy1 = baseY + (i + 1) * stepH;
        const halfW = (span * ratios[i]) / 2;
        const s0 = center - halfW;
        const s1 = center + halfW;
        if (i === 1) {
          measuredStepW = ((span * ratios[0]) - (span * ratios[1])) / 2;
        }
        // Outer white stepped voxel frame
        emitSlab(s0, s1, sy0, sy1, 0, 0, trimTiles);
        // Inner recessed colored voxel wall panel
        const innerHalfW = halfW - borderW;
        if (innerHalfW > V * 0.35 && i < numSteps - 1) {
          const topTrimH = Math.min(stepH * 0.45, V * 0.52);
          emitSlab(center - innerHalfW, center + innerHalfW, sy0, sy1 - topTrimH, -relief + 0.02, 0.02, wallTiles);
          // Crisp protruding bright facade face of inner colored panel (clean contrast)
          if (faceAxis === "x") {
            this.addVoxelBox(fixedCoord + outDepth - relief, sy0, center - innerHalfW, fixedCoord + outDepth + 0.015, sy1 - topTrimH, center + innerHalfW, wallTiles, lid, { noAo: true, noTop: true, noLeft: true, noFront: true, noBack: true });
          } else {
            this.addVoxelBox(center - innerHalfW, sy0, fixedCoord + outDepth - relief, center + innerHalfW, sy1 - topTrimH, fixedCoord + outDepth + 0.015, wallTiles, lid, { noAo: true, noTop: true, noBack: true, noLeft: true, noRight: true });
          }
        }
      }

      // Center attic medallion / window ornament block
      const medW = Math.min(span * 0.30, Math.max(0.68, V * 1.85));
      const medH = Math.min(gableH * 0.44, Math.max(0.64, V * 1.70));
      const medY0 = baseY + gableH * 0.22;
      emitSlab(center - medW / 2, center + medW / 2, medY0, medY0 + medH, V * 0.16, 0, trimTiles, true);
      const coreW = Math.max(0.32, medW * 0.52);
      const coreH = Math.max(0.32, medH * 0.52);
      const coreTile = style === "serratedCream" ? "vxGlassTeal" : (style === "serratedPink" ? "vxWinDark" : pal.dark);
      emitSlab(center - coreW / 2, center + coreW / 2, medY0 + (medH - coreH) / 2, medY0 + (medH + coreH) / 2, V * 0.20, 0, coreTile);

      if (recordMeasure) {
        const sEdge = center - (span * ratios[1]) / 2;
        this.addMeasureSegment("gableStepH", "山花单阶高", [fixedCoord + outDepth, baseY + stepH, sEdge], [fixedCoord + outDepth, baseY + stepH * 2, sEdge], stepH, `${numSteps}级实体三维阶梯山花`);
        this.addMeasureSegment("gableStepW", "山花单阶退台宽", [fixedCoord + outDepth, baseY + stepH, center - (span * ratios[0]) / 2], [fixedCoord + outDepth, baseY + stepH, sEdge], measuredStepW, "山花外缘白边台阶宽度");
      }
    }

    addCoarseVoxelUpperWall(faceAxis, fixedCoord, span0, span1, arcadeH, bodyH, pal, winCount, winStyle, lid, V, recordMeasure = false) {
      const span = span1 - span0;
      const upperH = bodyH - arcadeH;
      const recess = Math.max(0.24, V * 0.68);
      const eaveH = Math.max(0.34, V * 0.96);
      const eaveOver = Math.max(0.30, V * 0.92);
      const shadowBandH = Math.max(0.26, V * 0.74);
      const beltH = Math.max(0.30, V * 0.86);
      const beltOver = Math.max(0.22, V * 0.64);
      const sillH = Math.max(0.18, V * 0.52);
      const sillOver = Math.max(0.18, V * 0.50);

      const emitFaceBox = (s0, s1, y0, y1, dIn, dOut, tiles, opts = {}) => {
        if (faceAxis === "x") {
          this.addVoxelBox(fixedCoord - dIn, y0, s0, fixedCoord + dOut, y1, s1, tiles, lid, opts);
        } else {
          this.addVoxelBox(s0, y0, fixedCoord - dIn, s1, y1, fixedCoord + dOut, tiles, lid, opts);
        }
      };

      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };
      const wallTiles = { top: pal.mid, front: pal.mid, right: pal.mid, back: pal.shade, left: pal.shade, bottom: pal.dark };
      const darkTiles = { top: pal.dark, front: pal.dark, right: pal.dark, back: pal.dark, left: pal.dark, bottom: "vxTrimUnder" };

      // 1. Lower arcade belt course + dark underside shadow strip
      const beltY0 = arcadeH - beltH * 0.25;
      const beltY1 = beltY0 + beltH;
      emitFaceBox(span0 - 0.02, span1 + 0.02, beltY0, beltY1, 0.28, beltOver, trimTiles, { noAo: true, withBottom: true });

      // 2. Chunky balcony balustrade band right above belt course
      const railH = Math.min(upperH * 0.20, Math.max(0.32, V * 0.78));
      const railY0 = beltY1;
      const railY1 = railY0 + railH;
      emitFaceBox(span0, span1, railY0, railY1, recess, 0, darkTiles, { noAo: true });
      const balCount = Math.max(3, Math.round(span / (V * 1.95)));
      const balStep = span / balCount;
      const balW = Math.min(balStep * 0.54, V * 0.92);
      for (let bi = 0; bi < balCount; bi += 1) {
        const bc = span0 + (bi + 0.5) * balStep;
        emitFaceBox(bc - balW / 2, bc + balW / 2, railY0, railY1, 0.14, V * 0.34, trimTiles, { noAo: true });
      }
      emitFaceBox(span0, span1, railY1 - sillH * 0.48, railY1 + sillH * 0.32, 0.16, V * 0.44, trimTiles, { noAo: true, withBottom: true });

      // 3. Main roofline eave / cornice + crisp dark underside shadow frieze
      const eaveY1 = bodyH + eaveH * 0.28;
      const eaveY0 = eaveY1 - eaveH;
      const shadowY0 = eaveY0 - shadowBandH;
      emitFaceBox(span0 - 0.02, span1 + 0.02, eaveY0, eaveY1, 0.40, eaveOver, trimTiles, { noAo: true, withBottom: true });
      emitFaceBox(span0, span1, shadowY0, eaveY0, 0.30, eaveOver * 0.42, darkTiles, { noAo: true, withBottom: true });

      // 4. Real 3D recessed window openings & masonry piers between railY1 and shadowY0
      const winAreaY0 = railY1 + sillH * 0.32;
      const winAreaY1 = shadowY0;
      const winY0 = winAreaY0 + sillH * 0.9;
      const winY1 = Math.max(winY0 + V * 1.8, winAreaY1 - sillH * 1.05);

      // Continuous solid wall backing behind recessed windows
      emitFaceBox(span0, span1, winAreaY0, winAreaY1, recess + 0.35, -recess, "vxWinDark", { noAo: true });
      // Solid wall bands below/above window openings flush with main facade
      if (winY0 > winAreaY0 + 0.02) {
        emitFaceBox(span0, span1, winAreaY0, winY0, recess, 0, wallTiles, { noAo: true });
      }
      if (winAreaY1 > winY1 + 0.02) {
        emitFaceBox(span0, span1, winY1, winAreaY1, recess, 0, wallTiles, { noAo: true });
      }

      const bay = span / winCount;
      const winW = Math.min(bay * 0.56, Math.max(0.88, bay - Math.max(0.68, V * 1.75)));
      const edgePad = (bay - winW) / 2;

      // Left & right corner vertical trim piers
      const cornerTrimW = Math.min(edgePad * 0.68, Math.max(0.24, V * 0.64));
      emitFaceBox(span0, span0 + cornerTrimW, winAreaY0, winAreaY1, 0.14, V * 0.24, trimTiles, { noAo: true });
      emitFaceBox(span1 - cornerTrimW, span1, winAreaY0, winAreaY1, 0.14, V * 0.24, trimTiles, { noAo: true });

      let prevS = span0;
      for (let wi = 0; wi < winCount; wi += 1) {
        const ws0 = span0 + wi * bay + edgePad;
        const ws1 = ws0 + winW;
        // Masonry pier to the left of this window
        if (ws0 > prevS + 0.02) {
          emitFaceBox(prevS, ws0, winY0, winY1, recess, 0, wallTiles, { noAo: true });
        }
        prevS = ws1;

        // Recessed window glass blocks (2 bold chunky vertical panes + horizontal transom bar)
        const winH = winY1 - winY0;
        const transomH = Math.max(0.16, V * 0.44);
        const splitY = winY0 + winH * 0.52;
        const upperTile = winStyle === "manchuAmber"
          ? (wi % 2 === 0 ? "vxGlassTeal" : "vxGlassAmber")
          : (winStyle === "darkTeal" ? "vxGlassBlueDark" : "vxGlassTeal");
        const lowerTile = winStyle === "manchuAmber"
          ? (wi % 2 === 0 ? "vxGlassAmber" : "vxGlassTealDark")
          : (winStyle === "darkTeal" ? "vxWinDark" : "vxGlassTealDark");
        const frameInset = Math.min(winW * 0.14, V * 0.28);
        emitFaceBox(ws0 + frameInset, ws1 - frameInset, splitY + transomH / 2, winY1 - frameInset, recess + 0.04, -recess + 0.12, upperTile, { noAo: true });
        emitFaceBox(ws0 + frameInset, ws1 - frameInset, winY0 + frameInset, splitY - transomH / 2, recess + 0.04, -recess + 0.12, lowerTile, { noAo: true });
        // Bold horizontal transom bar
        emitFaceBox(ws0 + 0.02, ws1 - 0.02, splitY - transomH / 2, splitY + transomH / 2, recess * 0.72, -recess * 0.22, trimTiles, { noAo: true, withBottom: true });

        // Protruding 3D lintel (top) & sill (bottom) voxel blocks
        const capPad = Math.min(edgePad * 0.45, V * 0.35);
        emitFaceBox(ws0 - capPad, ws1 + capPad, winY1, winY1 + sillH, recess * 0.4, sillOver, trimTiles, { noAo: true, withBottom: true });
        emitFaceBox(ws0 - capPad, ws1 + capPad, winY0 - sillH, winY0, recess * 0.4, sillOver * 1.08, trimTiles, { noAo: true, withBottom: true });

        if (recordMeasure && wi === 0) {
          const midY = (winY0 + winY1) / 2;
          this.addMeasureSegment("windowW", "窗洞净宽", [fixedCoord, midY, ws0], [fixedCoord, midY, ws1], winW, "三维凹进窗洞净宽");
          this.addMeasureSegment("windowSillH", "窗台/过梁厚", [fixedCoord + sillOver, winY0 - sillH, (ws0 + ws1) / 2], [fixedCoord + sillOver, winY0, (ws0 + ws1) / 2], sillH, "三维出挑窗台块高");
        }
      }
      if (span1 > prevS + 0.02) {
        emitFaceBox(prevS, span1, winY0, winY1, recess, 0, wallTiles, { noAo: true });
      }

      if (recordMeasure) {
        const midS = (span0 + span1) / 2;
        this.addMeasureSegment("corniceH", "主檐口厚度", [fixedCoord + eaveOver, eaveY0, midS], [fixedCoord + eaveOver, eaveY1, midS], eaveH, "出挑明面檐口块高");
        this.addMeasureSegment("corniceOverhang", "主檐口出挑", [fixedCoord, eaveY1, midS], [fixedCoord + eaveOver, eaveY1, midS], eaveOver, "檐口沿街正向出挑");
        this.addMeasureSegment("eaveShadowH", "檐下阴影带高", [fixedCoord + eaveOver * 0.42, shadowY0, midS], [fixedCoord + eaveOver * 0.42, eaveY0, midS], shadowBandH, "檐下暗色明暗块高");
      }
    }

    addCoarseSampleArcadeShop(cfg, V, recordShop2 = false, recordShop1 = false) {
      const {
        x0, x1, z0, z1, arcadeH, bodyH, gableH, roofH,
        palKey, gableStyle, winStyle = "cyanGreen",
        archCount = 2, lanterns = false, pillarOrnaments = false,
        roofAxis = "x", steppedEnds = { north: true, south: true, west: true },
        cornerSouth = null,
        lid = 6
      } = cfg;
      const pal = VOXEL_PALETTES[palKey] || VOXEL_PALETTES.cream;
      const greyPal = VOXEL_PALETTES.grey;
      const width = x1 - x0;
      const depth = z1 - z0;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      const recess = 1.78;
      const xBack = x1 - recess;

      this.addGroundShadow(cx, cz, width, depth, bodyH + gableH * 0.72, 0.21);

      // 1. Deep dark recessed ground arcade core + chunky doorway blocks
      if (cornerSouth) {
        const zBack = z1 - recess;
        this.addVoxelBox(x0, 0, z0, xBack, arcadeH, zBack, {
          top: "vxCavityDeep", right: "vxCavityMid", front: "vxCavityMid", left: "vxGreyShade", back: "vxGreyMid"
        }, lid, { noTop: true, ao: 0.76 });
        this.addVoxelBox(xBack, arcadeH - V * 0.4, z0, x1, arcadeH, z1, "vxCavityDeep", lid, { noAo: true, withBottom: true });
        this.addVoxelBox(x0, arcadeH - V * 0.4, zBack, xBack, arcadeH, z1, "vxCavityDeep", lid, { noAo: true, withBottom: true });
        this.addVoxelBox(xBack, 0, z0, x1, arcadeH, z0 + V * 0.65, { top: "vxGreyLight", front: "vxCavityDeep", back: "vxGreyMid", right: "vxGreyMid", left: "vxGreyShade" }, lid);
        this.addVoxelBox(x0, 0, zBack, x0 + V * 0.65, arcadeH, z1, { top: "vxPinkMid", front: "vxPinkMid", back: "vxPinkShade", right: "vxCavityDeep", left: "vxPinkShade" }, lid);
      } else {
        this.addVoxelBox(x0, 0, z0, xBack, arcadeH, z1, {
          top: "vxCavityDeep", right: "vxCavityMid", front: "vxGreyMid", left: "vxGreyShade", back: "vxGreyMid"
        }, lid, { noTop: true, ao: 0.76 });
        this.addVoxelBox(xBack, arcadeH - V * 0.4, z0, x1, arcadeH, z1, "vxCavityDeep", lid, { noAo: true, withBottom: true });
        this.addVoxelBox(xBack, 0, z0, x1, arcadeH, z0 + V * 0.55, "vxGreyMid", lid);
        this.addVoxelBox(xBack, 0, z1 - V * 0.55, x1, arcadeH, z1, "vxGreyMid", lid);
      }

      // 2. East street arcade columns & TRUE 3D stepped voxel arches (ZERO alpha-cutout)
      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };
      const bayLen = depth / archCount;
      const colW = Math.min(bayLen * 0.34, Math.max(0.46, V * 1.28));
      const colDepthX = Math.max(0.50, V * 1.32);
      const beamH = Math.max(0.46, V * 1.12);

      for (let colIdx = 0; colIdx <= archCount; colIdx += 1) {
        const pz = z0 + colIdx * bayLen;
        const cz0 = colIdx === 0 ? pz : (colIdx === archCount ? pz - colW : pz - colW / 2);
        const cz1 = cz0 + colW;
        this.addVoxelBox(x1 - colDepthX, 0, cz0, x1 + 0.04, arcadeH, cz1, trimTiles, lid);
        // Chunky base plinth & capital blocks
        this.addVoxelBox(x1 - colDepthX - 0.04, 0, Math.max(z0, cz0 - V * 0.14), x1 + 0.12, V * 0.85, Math.min(z1, cz1 + V * 0.14), {
          top: "vxTrimFront", front: "vxTrimShade", right: "vxTrimShade", back: "vxTrimShade", left: "vxTrimShade"
        }, lid, { noAo: true });
      }
      // Continuous top arch beam
      this.addVoxelBox(x1 - colDepthX, arcadeH - beamH, z0, x1 + 0.06, arcadeH, z1, trimTiles, lid, { noAo: true, withBottom: true });

      // Stepped 3D voxel arch haunches + recessed wooden shop doors + lanterns
      const haunchSteps = V >= 0.42 ? 1 : 2;
      for (let bayIdx = 0; bayIdx < archCount; bayIdx += 1) {
        const bz0 = z0 + bayIdx * bayLen;
        const bz1 = bz0 + bayLen;
        const clear0 = bz0 + (bayIdx === 0 ? colW : colW / 2);
        const clear1 = bz1 - (bayIdx === archCount - 1 ? colW : colW / 2);
        const clearW = clear1 - clear0;
        for (let hs = 0; hs < haunchSteps; hs += 1) {
          const hW = Math.min(clearW * 0.24, V * (haunchSteps === 1 ? 0.72 : (0.78 - hs * 0.30)));
          const hY1 = arcadeH - beamH - hs * V * 0.65;
          const hY0 = hY1 - V * 0.68;
          this.addVoxelBox(x1 - colDepthX, hY0, clear0, x1 + 0.04, hY1, clear0 + hW, trimTiles, lid, { noAo: true, withBottom: true });
          this.addVoxelBox(x1 - colDepthX, hY0, clear1 - hW, x1 + 0.04, hY1, clear1, trimTiles, lid, { noAo: true, withBottom: true });
        }
        // Ground floor recessed wooden doorway block inside shadow cavity
        const doorMid = (clear0 + clear1) / 2;
        const doorW = Math.max(0.55, clearW * 0.56);
        this.addVoxelBox(xBack - 0.04, 0, doorMid - doorW / 2, xBack + 0.12, arcadeH * 0.66, doorMid + doorW / 2, "vxCavityDoor", lid, { noAo: true });
        if (lanterns) {
          this.addCoarseVoxelLantern(x1 + 0.14, arcadeH - beamH * 0.65, (bz0 + bz1) / 2, lid, V, recordShop1 && bayIdx === 0);
        }
      }
      if (pillarOrnaments) {
        const ornS = Math.max(0.28, V * 0.76);
        for (let colIdx = 1; colIdx < archCount; colIdx += 1) {
          const pz = z0 + colIdx * bayLen;
          this.addVoxelBox(x1 + 0.04, arcadeH - beamH - ornS * 1.1, pz - ornS / 2, x1 + 0.04 + ornS * 0.7, arcadeH - beamH - ornS * 0.1, pz + ornS / 2, {
            top: "vxLanternGold", front: "vxLanternOrange", right: "vxLanternRed", back: "vxLanternDeep", left: "vxLanternDeep", bottom: "vxLanternDeep"
          }, lid, { noAo: true, withBottom: true });
        }
      }

      // 3. Corner South arcade (Shop ①)
      if (cornerSouth) {
        const sArchCount = cornerSouth.archCount || 3;
        const sBayLen = width / sArchCount;
        const sColW = Math.min(sBayLen * 0.34, Math.max(0.46, V * 1.28));
        for (let colIdx = 0; colIdx < sArchCount; colIdx += 1) {
          const px = x0 + colIdx * sBayLen;
          const cx0 = colIdx === 0 ? px : px - sColW / 2;
          const cx1 = cx0 + sColW;
          this.addVoxelBox(cx0, 0, z1 - colDepthX, cx1, arcadeH, z1 + 0.04, trimTiles, lid);
        }
        this.addVoxelBox(x0, arcadeH - beamH, z1 - colDepthX, x1 + 0.04, arcadeH, z1 + 0.06, trimTiles, lid, { noAo: true, withBottom: true });
        for (let bayIdx = 0; bayIdx < sArchCount; bayIdx += 1) {
          const bx0 = x0 + bayIdx * sBayLen;
          const bx1 = bx0 + sBayLen;
          const c0 = bx0 + (bayIdx === 0 ? sColW : sColW / 2);
          const c1 = bx1 - (bayIdx === sArchCount - 1 ? colDepthX : sColW / 2);
          const cW = c1 - c0;
          for (let hs = 0; hs < haunchSteps; hs += 1) {
            const hW = Math.min(cW * 0.24, V * (haunchSteps === 1 ? 0.72 : (0.78 - hs * 0.30)));
            const hY1 = arcadeH - beamH - hs * V * 0.65;
            const hY0 = hY1 - V * 0.68;
            this.addVoxelBox(c0, hY0, z1 - colDepthX, c0 + hW, hY1, z1 + 0.04, trimTiles, lid, { noAo: true, withBottom: true });
            this.addVoxelBox(c1 - hW, hY0, z1 - colDepthX, c1, hY1, z1 + 0.04, trimTiles, lid, { noAo: true, withBottom: true });
          }
        }
      }

      // 4. Solid upper main body box (north, west, south non-street walls + roof deck base)
      const sPal = cornerSouth ? VOXEL_PALETTES[cornerSouth.palKey || "pink"] : greyPal;
      this.addVoxelBox(x0, arcadeH, z0, x1 - V * 0.62, bodyH, cornerSouth ? (z1 - V * 0.62) : z1, {
        top: "vxTrimShade", left: "vxGreyShade", back: "vxGreyMid", front: sPal.mid, right: pal.mid
      }, lid, { noAo: true });
      // Side horizontal trim courses on exposed north/south side walls
      if (!cornerSouth) {
        this.addVoxelBox(x0 - 0.02, bodyH - V * 0.72, z0 - 0.04, x1, bodyH + V * 0.22, z0 + V * 0.45, trimTiles, lid, { noAo: true });
        this.addVoxelBox(x0 - 0.02, bodyH - V * 0.72, z1 - V * 0.45, x1, bodyH + V * 0.22, z1 + 0.04, trimTiles, lid, { noAo: true });
      } else {
        this.addVoxelBox(x0 - 0.02, bodyH - V * 0.72, z0 - 0.04, x1, bodyH + V * 0.22, z0 + V * 0.45, trimTiles, lid, { noAo: true });
      }

      // 5. Detailed 3D voxel upper facades (windows, balustrades, overhanging eaves & shadow bands)
      const seamPad = cornerSouth ? 0 : 0.04;
      this.addCoarseVoxelUpperWall("x", x1, z0 + seamPad, z1 - seamPad, arcadeH, bodyH, pal, archCount, winStyle, lid, V, recordShop2);
      if (cornerSouth) {
        const csPal = VOXEL_PALETTES[cornerSouth.palKey || "pink"];
        this.addCoarseVoxelUpperWall("z", z1, x0 + 0.02, x1 + 0.02, arcadeH, bodyH, csPal, cornerSouth.archCount || 3, cornerSouth.winStyle || "darkTeal", lid, V, false);
      }

      // 6. True 3D stepped voxel gables (pediments)
      this.addCoarseVoxelGable("x", x1, z0 + seamPad, z1 - seamPad, bodyH + V * 0.20, gableH, pal, gableStyle, lid, V, recordShop2);
      if (cornerSouth && cornerSouth.gableStyle) {
        const csPal = VOXEL_PALETTES[cornerSouth.palKey || "pink"];
        this.addCoarseVoxelGable("z", z1, x0 + 0.04, x1 - 0.04, bodyH + V * 0.20, cornerSouth.gableH || gableH, csPal, cornerSouth.gableStyle, lid, V, false);
      }

      // 7. True 3D stepped voxel roof
      const roofInsetZ = cornerSouth ? Math.max(0.64, V * 1.55) : 0.28;
      const roofCz = cornerSouth ? (cz - V * 0.45) : cz;
      const roofW = width - Math.max(0.95, V * 2.1);
      this.addCoarseVoxelRoof(cx - Math.max(0.42, V * 0.95), bodyH + 0.04, roofCz, roofW, roofH, depth - roofInsetZ, roofAxis, lid, greyPal, steppedEnds, V, recordShop2);
    }

    addCoarseSampleSkybridge(x0, x1, z0, z1, deckY, totalH, lid, V) {
      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };
      const pierW = Math.max(0.44, V * 1.18);
      const deckH = Math.max(0.42, V * 1.02);
      const railH = Math.max(0.95, totalH - deckY - deckH);
      const xm = (x0 + x1) / 2;
      // 3 chunky piers
      this.addVoxelBox(x0, 0, z0, x0 + pierW, deckY, z1, trimTiles, lid);
      this.addVoxelBox(xm - pierW / 2, 0, z0, xm + pierW / 2, deckY, z1, trimTiles, lid);
      this.addVoxelBox(x1 - pierW, 0, z0, x1, deckY, z1, trimTiles, lid);
      // Stepped arch corbels under both spans
      for (const [a0, a1] of [[x0 + pierW, xm - pierW / 2], [xm + pierW / 2, x1 - pierW]]) {
        const cW = Math.min((a1 - a0) * 0.26, V * 0.85);
        const cH = V * 0.72;
        this.addVoxelBox(a0, deckY - cH, z0, a0 + cW, deckY, z1, trimTiles, lid, { noAo: true, withBottom: true });
        this.addVoxelBox(a1 - cW, deckY - cH, z0, a1, deckY, z1, trimTiles, lid, { noAo: true, withBottom: true });
      }
      // Bridge deck & overhanging side trims
      this.addVoxelBox(x0 - 0.06, deckY, z0 - 0.08, x1 + 0.06, deckY + deckH, z1 + 0.08, {
        top: "vxTrimFront", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront", bottom: "vxTrimUnder"
      }, lid, { noAo: true, withBottom: true });
      // Chunky voxel balustrades on north & south edges
      const railY0 = deckY + deckH;
      const railTopH = Math.max(0.24, V * 0.56);
      const postW = Math.max(0.32, V * 0.82);
      for (const rz of [z0, z1 - V * 0.56]) {
        this.addVoxelBox(x0, railY0 + railH - railTopH, rz, x1, railY0 + railH, rz + V * 0.56, trimTiles, lid, { noAo: true, withBottom: true });
        const posts = Math.max(4, Math.round((x1 - x0) / (V * 1.9)));
        const stepX = (x1 - x0 - postW) / posts;
        for (let pi = 0; pi <= posts; pi += 1) {
          const px = x0 + pi * stepX;
          this.addVoxelBox(px, railY0, rz + 0.04, px + postW, railY0 + railH - railTopH, rz + V * 0.52, trimTiles, lid, { noAo: true });
        }
      }
    }

    addCoarseLingnanHouse(cx, cz, w, d, wallH, roofH, axis = "x", lid = 0, V = 0.48) {
      const x0 = cx - w / 2, x1 = cx + w / 2;
      const z0 = cz - d / 2, z1 = cz + d / 2;
      const plinthH = Math.max(0.32, V * 0.78);
      const eaveH = Math.max(0.28, V * 0.68);
      const eaveOver = Math.max(0.18, V * 0.44);
      const shadowH = Math.max(0.24, V * 0.56);
      const brickPal = { mid: "vxBrickMid", shade: "vxBrickShade", dark: "vxBrickDark" };
      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };

      this.addGroundShadow(cx, cz, w, d, wallH + roofH * 0.72, 0.18);

      this.addVoxelBox(x0 - 0.08, 0, z0 - 0.08, x1 + 0.08, plinthH, z1 + 0.08, {
        top: "vxStoneShade", front: "vxStoneDark", right: "vxStoneDark", back: "vxStoneDark", left: "vxStoneDark"
      }, lid, { noTop: true, noAo: true });

      this.addVoxelBox(x0, plinthH, z0, x1, wallH - shadowH, z1, {
        top: "vxBrickLight", front: "vxBrickMid", right: "vxBrickLight", back: "vxBrickShade", left: "vxBrickShade"
      }, lid, { noTop: true });

      this.addVoxelBox(x0 - 0.04, wallH - shadowH, z0 - 0.04, x1 + 0.04, wallH, z1 + 0.04, {
        top: "vxBrickDark", front: "vxBrickDark", right: "vxBrickDark", back: "vxBrickDark", left: "vxBrickDark"
      }, lid, { noTop: true, noAo: true });
      this.addVoxelBox(x0 - eaveOver, wallH - 0.04, z0 - eaveOver, x1 + eaveOver, wallH + eaveH, z1 + eaveOver, trimTiles, lid, { noAo: true, withBottom: true });

      const winH = Math.min(1.15, Math.max(0.76, V * 2.1));
      const winY0 = Math.max(plinthH + 0.45, wallH * 0.42);
      const winY1 = Math.min(wallH - shadowH - 0.25, winY0 + winH);
      const sillH = Math.max(0.18, V * 0.44);
      const frameOut = Math.max(0.10, V * 0.24);

      if (winY1 > winY0 + 0.35) {
        const sCols = w >= 8.2 ? 3 : 2;
        const sStep = (w - 1.2) / sCols;
        for (let i = 0; i < sCols; i += 1) {
          const wx = x0 + 0.6 + (i + 0.5) * sStep;
          const isDoor = sCols === 3 && i === 1;
          const ow = Math.min(sStep * 0.54, isDoor ? 1.35 : 1.12);
          if (isDoor) {
            this.addVoxelBox(wx - ow / 2, 0.02, z1 - 0.08, wx + ow / 2, Math.min(wallH - shadowH - 0.35, 2.35), z1 + 0.08, {
              top: "vxWoodDark", front: "vxWoodDark", right: "vxWoodDark", left: "vxWoodDark", back: "vxWoodDark"
            }, lid, { noAo: true });
            this.addVoxelBox(wx - ow / 2 - 0.14, Math.min(wallH - shadowH - 0.35, 2.35), z1 - 0.04, wx + ow / 2 + 0.14, Math.min(wallH - shadowH - 0.35, 2.35) + sillH, z1 + frameOut + 0.06, trimTiles, lid, { noAo: true, withBottom: true });
          } else {
            this.addVoxelBox(wx - ow / 2, winY0, z1 - 0.06, wx + ow / 2, winY1, z1 + 0.06, "vxWinDark", lid, { noAo: true });
            this.addVoxelBox(wx - ow / 2 - 0.12, winY1, z1 - 0.02, wx + ow / 2 + 0.12, winY1 + sillH, z1 + frameOut + 0.04, trimTiles, lid, { noAo: true, withBottom: true });
            this.addVoxelBox(wx - ow / 2 - 0.12, winY0 - sillH, z1 - 0.02, wx + ow / 2 + 0.12, winY0, z1 + frameOut + 0.04, trimTiles, lid, { noAo: true, withBottom: true });
          }
        }
        const eCols = d >= 6.4 ? 2 : 1;
        const eStep = (d - 1.2) / eCols;
        for (let i = 0; i < eCols; i += 1) {
          const wz = z0 + 0.6 + (i + 0.5) * eStep;
          const ow = Math.min(eStep * 0.52, 1.12);
          this.addVoxelBox(x1 - 0.06, winY0, wz - ow / 2, x1 + 0.06, winY1, wz + ow / 2, "vxWinDark", lid, { noAo: true });
          this.addVoxelBox(x1 - 0.02, winY1, wz - ow / 2 - 0.12, x1 + frameOut + 0.04, winY1 + sillH, wz + ow / 2 + 0.12, trimTiles, lid, { noAo: true, withBottom: true });
          this.addVoxelBox(x1 - 0.02, winY0 - sillH, wz - ow / 2 - 0.12, x1 + frameOut + 0.04, winY0, wz + ow / 2 + 0.12, trimTiles, lid, { noAo: true, withBottom: true });
        }
      }

      const steppedEnds = axis === "x"
        ? { north: false, south: false, west: true }
        : { north: true, south: true, west: false };
      this.addCoarseVoxelRoof(cx, wallH + eaveH * 0.72, cz, w + 0.24, roofH, d + 0.24, axis, lid, brickPal, steppedEnds, V, false);
      if (axis === "x") {
        const parapetT = Math.max(0.36, V * 0.98);
        const steps = V >= 0.42 ? 3 : 4;
        const stepH = roofH / steps;
        const halfSpan = Math.max(0.3, (d - 0.6) / 2);
        for (let s = 0; s < steps; s += 1) {
          const sy0 = wallH + eaveH * 0.72 + s * stepH;
          const sy1 = sy0 + stepH + V * 0.30;
          const inset = (s / steps) * halfSpan;
          this.addVoxelBox(x1 - parapetT + 0.04, sy0, z0 + inset, x1 + 0.16, sy1, z1 - inset, trimTiles, lid, { noAo: true });
        }
      }
    }

    addCoarseVoxelTree(cx, cz, scale = 1.0, lid = 0, isBanyan = false, V = 0.48) {
      const trunkH = (isBanyan ? 3.2 : 2.1) * scale;
      const canopyR = (isBanyan ? 4.35 : 2.15) * scale;
      const trunkR = (isBanyan ? 0.92 : 0.40) * scale;
      const layerH = Math.max(0.72, V * 1.95) * (isBanyan ? 1.15 : 0.95) * Math.min(1.25, Math.max(0.82, scale));

      this.addGroundShadow(cx, cz, canopyR * 2.15, canopyR * 1.95, trunkH + layerH * 3.0, 0.19);

      if (isBanyan) {
        this.addVoxelBox(cx - trunkR * 1.5, 0.55, cz - trunkR * 1.4, cx + trunkR * 1.5, 1.15 * scale, cz + trunkR * 1.4, {
          top: "vxTrunkMid", front: "vxTrunkMid", right: "vxTrunkMid", back: "vxTrunkDark", left: "vxTrunkDark"
        }, lid, { noAo: true });
        this.addVoxelBox(cx - trunkR, 0.85 * scale, cz - trunkR, cx + trunkR, trunkH + 0.8, cz + trunkR, {
          top: "vxTrunkMid", front: "vxTrunkMid", right: "vxTrunkMid", back: "vxTrunkDark", left: "vxTrunkDark"
        }, lid, { noAo: true });
        const roots = [[-2.0, 1.3], [1.9, 1.5], [-1.7, -1.6], [2.1, -1.2]];
        for (const [rx, rz] of roots) {
          this.addVoxelBox(cx + rx * scale - 0.24, 0.55, cz + rz * scale - 0.24, cx + rx * scale + 0.24, trunkH + 1.1, cz + rz * scale + 0.24, "vxTrunkDark", lid, { noAo: true });
        }
      } else {
        this.addVoxelBox(cx - trunkR, 0, cz - trunkR, cx + trunkR, trunkH + 0.5, cz + trunkR, {
          top: "vxTrunkMid", front: "vxTrunkMid", right: "vxTrunkMid", back: "vxTrunkDark", left: "vxTrunkDark"
        }, lid, { noAo: true });
      }

      const y0 = trunkH;
      const leafDarkTiles = { top: "vxLeafMid", front: "vxLeafDark", right: "vxLeafDark", back: "vxLeafDeep", left: "vxLeafDeep", bottom: "vxLeafDeep" };
      const leafMidTiles = { top: "vxLeafLight", front: "vxLeafMid", right: "vxLeafMid", back: "vxLeafDark", left: "vxLeafDark", bottom: "vxLeafDeep" };
      const leafBrightTiles = { top: "vxLeafLight", front: "vxLeafLight", right: "vxLeafMid", back: "vxLeafMid", left: "vxLeafDark", bottom: "vxLeafDark" };

      const r1x = canopyR * 0.96, r1z = canopyR * 0.92;
      this.addVoxelBox(cx - r1x, y0, cz - r1z, cx + r1x, y0 + layerH, cz + r1z, leafDarkTiles, lid, { noAo: true, withBottom: true });
      this.addVoxelBox(cx - r1x * 1.14, y0 + layerH * 0.22, cz - r1z * 0.58, cx + r1x * 1.14, y0 + layerH * 1.05, cz + r1z * 0.58, leafDarkTiles, lid, { noAo: true, withBottom: true });
      this.addVoxelBox(cx - r1x * 0.58, y0 + layerH * 0.22, cz - r1z * 1.14, cx + r1x * 0.58, y0 + layerH * 1.05, cz + r1z * 1.14, leafDarkTiles, lid, { noAo: true, withBottom: true });

      const r2 = canopyR * 0.80;
      const y1 = y0 + layerH * 0.88;
      this.addVoxelBox(cx - r2 * 0.95, y1, cz - r2 * 0.95, cx + r2 * 1.02, y1 + layerH, cz + r2 * 1.02, leafMidTiles, lid, { noAo: true, withBottom: true });

      const r3 = canopyR * 0.56;
      const y2 = y1 + layerH * 0.86;
      this.addVoxelBox(cx - r3 * 0.85, y2, cz - r3 * 0.85, cx + r3 * 1.05, y2 + layerH * 0.85, cz + r3 * 1.05, leafBrightTiles, lid, { noAo: true });

      if (isBanyan) {
        const bLobes = [[-2.4, 1.4, 1.55], [2.3, 1.1, 1.45], [-1.8, -2.0, 1.40], [2.0, -1.8, 1.35]];
        for (const [ox, oz, lr] of bLobes) {
          this.addVoxelBox(cx + ox * scale - lr, y0 + layerH * 0.45, cz + oz * scale - lr, cx + ox * scale + lr, y0 + layerH * 1.65, cz + oz * scale + lr, leafMidTiles, lid, { noAo: true, withBottom: true });
        }
        const r4 = canopyR * 0.34;
        const y3 = y2 + layerH * 0.72;
        this.addVoxelBox(cx - r4, y3, cz - r4, cx + r4, y3 + layerH * 0.75, cz + r4, leafBrightTiles, lid, { noAo: true });
      }
    }

    addCoarseUmbrellaTable(cx, cz, lid = 0, V = 0.48) {
      this.addGroundShadow(cx, cz, 3.0, 3.0, 2.7, 0.16);
      const poleR = Math.max(0.16, V * 0.36);
      this.addVoxelBox(cx - poleR, 0, cz - poleR, cx + poleR, 2.25, cz + poleR, "vxWoodDark", lid, { noAo: true });
      this.addVoxelBox(cx - 0.72, 0.86, cz - 0.72, cx + 0.72, 1.14, cz + 0.72, {
        top: "vxWoodLight", front: "vxWoodMid", right: "vxWoodMid", back: "vxWoodDark", left: "vxWoodDark"
      }, lid, { noAo: true, withBottom: true });
      this.addVoxelBox(cx - 1.62, 2.12, cz - 1.62, cx + 1.62, 2.52, cz + 1.62, {
        top: "vxCanopyLight", front: "vxCanopyShade", right: "vxCanopyShade", back: "vxOchreShade", left: "vxOchreShade", bottom: "vxWoodDark"
      }, lid, { noAo: true, withBottom: true });
      this.addVoxelBox(cx - 1.02, 2.52, cz - 1.02, cx + 1.02, 2.86, cz + 1.02, {
        top: "vxOchreMid", front: "vxOchreMid", right: "vxOchreShade", back: "vxOchreShade", left: "vxOchreShade"
      }, lid, { noAo: true });
      this.addVoxelBox(cx - 0.42, 2.86, cz - 0.42, cx + 0.42, 3.12, cz + 0.42, "vxTrimTop", lid, { noAo: true });
    }

    addCoarseMarketStall(cx, cz, isGreen = false, lid = 0, V = 0.48) {
      this.addGroundShadow(cx, cz, 3.3, 2.8, 2.7, 0.16);
      this.addVoxelBox(cx - 1.25, 0, cz - 0.88, cx + 1.25, 0.96, cz + 0.88, {
        top: "vxWoodLight", front: "vxWoodMid", right: "vxWoodMid", back: "vxWoodDark", left: "vxWoodDark"
      }, lid, { noAo: true });
      const pR = Math.max(0.14, V * 0.30);
      for (const [px, pz] of [[-1.08, -0.72], [1.08, -0.72], [-1.08, 0.72], [1.08, 0.72]]) {
        this.addVoxelBox(cx + px - pR, 0.96, cz + pz - pR, cx + px + pR, 2.30, cz + pz + pR, "vxWoodDark", lid, { noAo: true });
      }
      const stripeA = isGreen ? "vxGreenAwning" : "vxCanopyLight";
      const stripeB = isGreen ? "vxGreenAwningDark" : "vxCanopyShade";
      const segs = 4;
      const w = 3.1;
      const segW = w / segs;
      for (let i = 0; i < segs; i += 1) {
        const sx0 = cx - w / 2 + i * segW;
        const sx1 = sx0 + segW;
        const tile = i % 2 === 0 ? stripeA : stripeB;
        this.addVoxelBox(sx0, 2.24, cz - 1.32, sx1, 2.62, cz + 1.32, {
          top: tile, front: stripeB, right: stripeB, back: stripeB, left: stripeB, bottom: "vxWoodDark"
        }, lid, { noAo: true, withBottom: true });
        this.addVoxelBox(sx0, 2.62, cz - 0.74, sx1, 2.98, cz + 0.74, {
          top: tile, front: tile, right: stripeB, back: stripeB, left: stripeB
        }, lid, { noAo: true });
      }
    }

    addCoarseCar(cx, cz, bodyTile = "vxCarWhite", lid = 0) {
      this.addGroundShadow(cx, cz, 4.0, 2.1, 1.6, 0.16);
      for (const [wx, wz] of [[-1.15, -0.82], [1.15, -0.82], [-1.15, 0.82], [1.15, 0.82]]) {
        this.addVoxelBox(cx + wx - 0.34, 0.02, cz + wz - 0.22, cx + wx + 0.34, 0.56, cz + wz + 0.22, "vxStoneDark", lid, { noAo: true });
      }
      this.addVoxelBox(cx - 1.82, 0.32, cz - 0.88, cx + 1.82, 1.06, cz + 0.88, {
        top: bodyTile, front: bodyTile, right: bodyTile, back: "vxStoneShade", left: "vxStoneShade", bottom: "vxStoneDark"
      }, lid, { noAo: true, withBottom: true });
      this.addVoxelBox(cx - 1.02, 1.06, cz - 0.72, cx + 0.86, 1.68, cz + 0.72, {
        top: bodyTile, front: "vxWinDark", right: "vxWinDark", back: "vxWinDark", left: "vxWinDark"
      }, lid, { noAo: true });
      this.addVoxelBox(cx - 0.94, 1.56, cz - 0.68, cx + 0.78, 1.74, cz + 0.68, bodyTile, lid, { noAo: true });
      this.addVoxelBox(cx + 1.76, 0.56, cz - 0.68, cx + 1.88, 0.82, cz - 0.34, "vxTrimTop", lid, { noAo: true });
      this.addVoxelBox(cx + 1.76, 0.56, cz + 0.34, cx + 1.88, 0.82, cz + 0.68, "vxTrimTop", lid, { noAo: true });
    }

    addCoarsePedestrian(cx, cz, shirtSlot = "vxPedShirtA") {
      this.addGroundShadow(cx, cz, 0.92, 0.92, 1.55, 0.14);
      this.addVoxelBox(cx - 0.24, 0.04, cz - 0.20, cx + 0.24, 0.78, cz + 0.20, "vxStoneDark", 0, { noAo: true });
      this.addVoxelBox(cx - 0.34, 0.78, cz - 0.24, cx + 0.34, 1.48, cz + 0.24, shirtSlot, 0, { noAo: true });
      this.addVoxelBox(cx - 0.24, 1.48, cz - 0.24, cx + 0.24, 1.94, cz + 0.24, "vxPedSkin", 0, { noAo: true });
      this.addVoxelBox(cx - 0.25, 1.86, cz - 0.25, cx + 0.25, 2.04, cz + 0.25, "vxWoodDark", 0, { noAo: true });
    }

    addCoarseEmbankmentAndQuay(V = 0.48) {
      const stoneQuay = { top: "vxStoneTop", front: "vxStoneMid", right: "vxStoneLight", back: "vxStoneShade", left: "vxStoneShade" };
      const stoneRib = { top: "vxStoneLight", front: "vxStoneShade", right: "vxStoneMid", back: "vxStoneDark", left: "vxStoneDark" };
      const copingTiles = { top: "vxStoneTop", front: "vxStoneLight", right: "vxStoneLight", back: "vxStoneShade", left: "vxStoneShade", bottom: "vxStoneDark" };

      this.addVoxelBox(13.3, -1.78, -110, 14.35, 0.04, 10.6, stoneQuay, 0, { noAo: true });
      this.addVoxelBox(13.25, -0.02, -110, 14.52, 0.24, 10.65, copingTiles, 0, { noAo: true, withBottom: true });
      this.addVoxelBox(14.32, -1.76, -110, 14.78, -1.48, 10.8, "vxWaterEdge", 0, { noAo: true });
      this.addVoxelBox(14.74, -1.73, -110, 15.22, -1.60, 10.8, "vxWaterFoam", 0, { noAo: true });
      for (let rz = -104; rz <= 8; rz += 6.2) {
        this.addVoxelBox(14.22, -1.74, rz - 0.42, 14.62, -0.04, rz + 0.42, stoneRib, 0, { noAo: true });
      }

      this.addVoxelBox(7.55, -1.78, 21.8, 8.60, 0.04, 126, stoneQuay, 0, { noAo: true });
      this.addVoxelBox(7.50, -0.02, 21.8, 8.78, 0.24, 126, copingTiles, 0, { noAo: true, withBottom: true });
      this.addVoxelBox(8.56, -1.76, 21.8, 9.02, -1.48, 126, "vxWaterEdge", 0, { noAo: true });
      this.addVoxelBox(8.98, -1.73, 21.8, 9.46, -1.60, 126, "vxWaterFoam", 0, { noAo: true });
      for (let rz = 25; rz <= 118; rz += 6.2) {
        this.addVoxelBox(8.46, -1.74, rz - 0.42, 8.86, -0.04, rz + 0.42, stoneRib, 0, { noAo: true });
      }

      const postW = Math.max(0.56, V * 1.24);
      const postH = Math.max(0.96, V * 2.05);
      const railH = Math.max(0.24, V * 0.54);
      const addBalustradeRun = (bx, zStart, zEnd, stepZ) => {
        this.addVoxelBox(bx - 0.22, postH - railH - 0.08, zStart, bx + 0.22, postH - 0.08, zEnd, copingTiles, 0, { noAo: true, withBottom: true });
        this.addVoxelBox(bx - 0.16, 0.24, zStart, bx + 0.16, 0.46, zEnd, stoneRib, 0, { noAo: true });
        for (let pz = zStart; pz <= zEnd + 0.01; pz += stepZ) {
          this.addVoxelBox(bx - postW / 2, 0.22, pz - postW / 2, bx + postW / 2, postH + 0.10, pz + postW / 2, copingTiles, 0, { noAo: true });
        }
      };
      addBalustradeRun(13.92, -60.8, 9.4, 6.2);
      addBalustradeRun(13.92, -96.0, -70.4, 6.4);
      addBalustradeRun(8.12, 23.2, 63.4, 6.2);
      addBalustradeRun(8.12, 72.2, 97.0, 6.2);

      this.addVoxelBox(-41.2, 0.02, -34.7, -2.3, 0.20, -34.1, copingTiles, 0, { noAo: true });
      this.addVoxelBox(-41.2, 0.02, -14.9, -2.3, 0.20, -14.3, copingTiles, 0, { noAo: true });
      this.addVoxelBox(-24.2, 0.02, 16.2, 8.6, 0.18, 16.7, copingTiles, 0, { noAo: true });
    }

    addCoarsePengjiangBridge(idx, V = 0.48) {
      const stoneTop = { top: "vxStoneTop", front: "vxStoneLight", right: "vxStoneLight", back: "vxStoneShade", left: "vxStoneShade", bottom: "vxStoneDark" };
      const stoneMid = { top: "vxStoneLight", front: "vxStoneMid", right: "vxStoneMid", back: "vxStoneShade", left: "vxStoneShade", bottom: "vxStoneDark" };
      const stoneDark = { top: "vxStoneShade", front: "vxStoneDark", right: "vxStoneDark", back: "vxStoneDark", left: "vxStoneDark", bottom: "vxStoneDark" };

      this.addVoxelBox(9.8, -1.8, -68.8, 14.8, 2.42, -62.2, stoneMid, idx, { noAo: true });
      this.addTexturedBox(31.5, 2.38, -65.5, 42.6, 0.64, 6.4, { top: "promenade", side: "vxStoneMid" }, idx, { topURep: 5, topVRep: 1, noAo: true });
      this.addVoxelBox(10.0, 2.34, -68.9, 53.0, 3.06, -68.15, stoneTop, idx, { noAo: true, withBottom: true });
      this.addVoxelBox(10.0, 2.34, -62.85, 53.0, 3.06, -62.10, stoneTop, idx, { noAo: true, withBottom: true });

      const pierXs = [19.8, 31.5, 43.2];
      for (const px of pierXs) {
        this.addVoxelBox(px - 1.65, -1.78, -69.2, px + 1.65, -1.56, -61.8, "vxWaterFoam", idx, { noAo: true });
        this.addVoxelBox(px - 1.35, -1.85, -68.9, px + 1.35, 0.45, -62.1, stoneDark, idx, { noAo: true });
        this.addVoxelBox(px - 1.05, 0.45, -68.6, px + 1.05, 2.38, -62.4, stoneMid, idx, { noAo: true });
      }
      const spans = [[14.8, 18.75], [20.85, 30.45], [32.55, 42.15], [44.25, 52.4]];
      for (const [sx0, sx1] of spans) {
        const spanLen = sx1 - sx0;
        this.addVoxelBox(sx0, 1.56, -68.75, sx1, 2.38, -68.15, stoneMid, idx, { noAo: true, withBottom: true });
        this.addVoxelBox(sx0, 1.56, -62.85, sx1, 2.38, -62.25, stoneMid, idx, { noAo: true, withBottom: true });
        this.addVoxelBox(sx0, 1.72, -68.15, sx1, 2.38, -62.85, stoneDark, idx, { noAo: true, withBottom: true });
        const h1 = spanLen * 0.24;
        const h2 = spanLen * 0.13;
        for (const [hx0, hx1, hy0, hy1] of [
          [sx0, sx0 + h1, 0.92, 1.58], [sx1 - h1, sx1, 0.92, 1.58],
          [sx0, sx0 + h2, 0.25, 0.94], [sx1 - h2, sx1, 0.25, 0.94]
        ]) {
          this.addVoxelBox(hx0, hy0, -68.70, hx1, hy1, -62.30, stoneMid, idx, { noAo: true, withBottom: true });
        }
      }
      for (let lx = 13.5; lx <= 50.5; lx += 6.0) {
        this.addVoxelBox(lx - 0.34, 3.04, -68.92, lx + 0.34, 3.92, -68.12, stoneTop, idx, { noAo: true });
        this.addVoxelBox(lx - 0.34, 3.04, -62.88, lx + 0.34, 3.92, -62.08, stoneTop, idx, { noAo: true });
      }
      for (const lx of [19.8, 31.5, 43.2]) {
        for (const lz of [-68.52, -62.48]) {
          this.addVoxelBox(lx - 0.18, 3.90, lz - 0.18, lx + 0.18, 5.05, lz + 0.18, "vxSteelDark", idx, { noAo: true });
          this.addVoxelBox(lx - 0.34, 5.02, lz - 0.34, lx + 0.34, 5.52, lz + 0.34, "vxLanternGold", idx, { noAo: true });
        }
      }
    }

    addCoarseQimingliGate(idx, V = 0.48) {
      const cx = -32.0, cz = -45.5;
      const stoneBase = { top: "vxStoneLight", front: "vxStoneDark", right: "vxStoneDark", back: "vxStoneDark", left: "vxStoneDark" };
      const brickCol = { top: "vxBrickLight", front: "vxBrickMid", right: "vxBrickLight", back: "vxBrickShade", left: "vxBrickShade" };
      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };
      this.addGroundShadow(cx, cz, 8.8, 2.6, 6.8, 0.20);

      const colXs = [-35.8, -33.7, -30.3, -28.2];
      for (const px of colXs) {
        const isMain = Math.abs(px - cx) < 2.2;
        const colH = isMain ? 5.25 : 4.25;
        this.addVoxelBox(px - 0.56, 0, cz - 0.96, px + 0.56, 0.85, cz + 0.96, stoneBase, idx, { noAo: true });
        this.addVoxelBox(px - 0.46, 0.85, cz - 0.78, px + 0.46, colH, cz + 0.78, brickCol, idx, { noAo: true });
      }
      for (const [bx0, bx1] of [[-35.8, -33.7], [-30.3, -28.2]]) {
        this.addVoxelBox(bx0 - 0.3, 3.55, cz - 0.76, bx1 + 0.3, 4.30, cz + 0.76, brickCol, idx, { noAo: true, withBottom: true });
        this.addVoxelBox(bx0 - 0.65, 4.28, cz - 1.15, bx1 + 0.65, 4.76, cz + 1.15, { top: "vxRoofLight", front: "vxRoofDark", right: "vxRoofMid", back: "vxRoofDark", left: "vxRoofDark" }, idx, { noAo: true, withBottom: true });
        this.addVoxelBox(bx0 - 0.42, 4.74, cz - 0.72, bx1 + 0.42, 5.12, cz + 0.72, { top: "vxRidgeTop", front: "vxRidgeSide", right: "vxRidgeSide", back: "vxRidgeSide", left: "vxRidgeSide" }, idx, { noAo: true });
      }
      this.addVoxelBox(-33.9, 3.85, cz - 0.86, -30.1, 5.55, cz + 0.86, trimTiles, idx, { noAo: true, withBottom: true });
      this.addVoxelBox(-33.4, 4.20, cz + 0.80, -30.6, 5.22, cz + 1.06, { top: "vxOchreMid", front: "vxOchreMid", right: "vxOchreShade", left: "vxOchreShade", back: "vxOchreShade" }, idx, { noAo: true });
      this.addVoxelBox(-33.0, 4.44, cz + 1.00, -31.0, 5.00, cz + 1.14, "vxWinDark", idx, { noAo: true });
      this.addVoxelBox(-34.6, 5.52, cz - 1.38, -29.4, 6.08, cz + 1.38, { top: "vxRoofLight", front: "vxRoofDark", right: "vxRoofMid", back: "vxRoofDark", left: "vxRoofDark" }, idx, { noAo: true, withBottom: true });
      this.addVoxelBox(-34.1, 6.06, cz - 0.90, -29.9, 6.54, cz + 0.90, { top: "vxRoofMid", front: "vxRoofDark", right: "vxRoofMid", back: "vxRoofDark", left: "vxRoofDark" }, idx, { noAo: true });
      this.addVoxelBox(-34.3, 6.52, cz - 0.44, -29.7, 6.92, cz + 0.44, { top: "vxRidgeTop", front: "vxRidgeSide", right: "vxRidgeSide", back: "vxRidgeSide", left: "vxRidgeSide" }, idx, { noAo: true });
    }

    addCoarseCustomsHouse(idx, V = 0.48) {
      const hx = -16.8, hz = -39.5, hw = 18.0, hd = 9.4, hh = 7.4;
      const x0 = hx - hw / 2, x1 = hx + hw / 2;
      const z0 = hz - hd / 2, z1 = hz + hd / 2;
      const creamPal = VOXEL_PALETTES.cream;
      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };
      const arcadeH = 3.65;

      this.addGroundShadow(hx, hz, hw, hd, hh + 4.8, 0.22);

      this.addVoxelBox(x0, 0, z0, x1, arcadeH, z1 - 1.75, {
        top: "vxCavityDeep", front: "vxCavityMid", right: "vxCreamShade", back: "vxCreamShade", left: "vxCreamDark"
      }, idx, { noTop: true });
      this.addVoxelBox(x0, arcadeH - 0.36, z1 - 1.75, x1, arcadeH, z1, "vxCavityDeep", idx, { noAo: true, withBottom: true });

      const bays = 6;
      const bayW = hw / bays;
      const colW = Math.max(0.56, V * 1.30);
      for (let i = 0; i <= bays; i += 1) {
        const px = x0 + i * bayW;
        const cx0 = i === 0 ? px : (i === bays ? px - colW : px - colW / 2);
        this.addVoxelBox(cx0, 0, z1 - 0.78, cx0 + colW, arcadeH, z1 + 0.08, trimTiles, idx);
      }
      this.addVoxelBox(x0 - 0.14, arcadeH - 0.56, z1 - 0.82, x1 + 0.14, arcadeH + 0.24, z1 + 0.28, trimTiles, idx, { noAo: true, withBottom: true });
      for (let i = 0; i < bays; i += 1) {
        const bx0 = x0 + i * bayW + colW * 0.55;
        const bx1 = x0 + (i + 1) * bayW - colW * 0.55;
        const hW = Math.min((bx1 - bx0) * 0.26, V * 0.92);
        this.addVoxelBox(bx0, arcadeH - 1.06, z1 - 0.76, bx0 + hW, arcadeH - 0.52, z1 + 0.06, trimTiles, idx, { noAo: true, withBottom: true });
        this.addVoxelBox(bx1 - hW, arcadeH - 1.06, z1 - 0.76, bx1, arcadeH - 0.52, z1 + 0.06, trimTiles, idx, { noAo: true, withBottom: true });
        const dm = (bx0 + bx1) / 2;
        this.addVoxelBox(dm - 0.66, 0, z1 - 1.80, dm + 0.66, 2.55, z1 - 1.56, "vxCavityDoor", idx, { noAo: true });
      }

      this.addVoxelBox(x0, arcadeH, z0, x1, hh, z1 - 0.42, {
        top: "vxTrimShade", front: "vxCreamMid", right: "vxCreamMid", back: "vxCreamShade", left: "vxCreamShade"
      }, idx, { noAo: true });
      this.addCoarseVoxelUpperWall("z", z1, x0 + 0.04, x1 - 0.04, arcadeH, hh, creamPal, bays, "darkTeal", idx, V, false);
      this.addCoarseVoxelGable("z", z1, hx - 4.0, hx + 4.0, hh + V * 0.20, 2.05, creamPal, "serratedCream", idx, V, false);
      this.addCoarseVoxelRoof(hx - 1.2, hh + 0.14, hz - 0.25, hw - 2.4, 2.0, hd - 1.0, "x", idx, creamPal, { north: true, south: false, west: true }, V, false);

      // East riverside cream qilou wing matching (-4.5, -40.0, 6.8, 11.2, 7.2)
      this.addCoarseSampleArcadeShop({
        x0: -7.9, x1: -1.1, z0: -45.6, z1: -34.4,
        arcadeH: 3.45, bodyH: 7.2, gableH: 2.10, roofH: 1.70,
        palKey: "cream", gableStyle: "serratedCream", winStyle: "darkTeal",
        archCount: 3, lanterns: false, pillarOrnaments: false,
        roofAxis: "z", steppedEnds: { north: true, south: true, west: false },
        lid: idx
      }, V, false, false);

      // Grand Square Clock Tower at tx = -9.6, tz = -40.0
      const tx = -9.6, tz = -40.0;
      const tw = 4.6, th = 5.4;
      const tBase = hh + 0.15;
      this.addVoxelBox(tx - tw / 2, tBase, tz - tw / 2, tx + tw / 2, tBase + th, tz + tw / 2, {
        top: "vxTrimTop", front: "vxCreamMid", right: "vxCreamMid", back: "vxCreamShade", left: "vxCreamShade"
      }, idx, { noAo: true });
      this.addVoxelBox(tx - tw / 2 - 0.30, tBase + th - 0.45, tz - tw / 2 - 0.30, tx + tw / 2 + 0.30, tBase + th + 0.20, tz + tw / 2 + 0.30, trimTiles, idx, { noAo: true, withBottom: true });
      this.addVoxelBox(tx - tw / 2 - 0.20, tBase + 1.85, tz - tw / 2 - 0.20, tx + tw / 2 + 0.20, tBase + 2.20, tz + tw / 2 + 0.20, trimTiles, idx, { noAo: true });
      const cfY0 = tBase + 2.55, cfY1 = tBase + 4.48, cfHalf = 1.15;
      const cfMidY = (cfY0 + cfY1) / 2;
      this.addVoxelBox(tx - cfHalf - 0.22, cfY0 - 0.22, tz + tw / 2 - 0.04, tx + cfHalf + 0.22, cfY1 + 0.22, tz + tw / 2 + 0.22, trimTiles, idx, { noAo: true });
      this.addVoxelBox(tx - cfHalf, cfY0, tz + tw / 2 + 0.16, tx + cfHalf, cfY1, tz + tw / 2 + 0.32, "vxClockFace", idx, { noAo: true });
      this.addVoxelBox(tx - 0.15, cfMidY - 0.06, tz + tw / 2 + 0.30, tx + 0.15, cfY1 - 0.26, tz + tw / 2 + 0.42, "vxClockHand", idx, { noAo: true });
      this.addVoxelBox(tx - 0.06, cfMidY - 0.15, tz + tw / 2 + 0.30, tx + cfHalf - 0.24, cfMidY + 0.15, tz + tw / 2 + 0.42, "vxClockHand", idx, { noAo: true });
      this.addVoxelBox(tx + tw / 2 - 0.04, cfY0 - 0.22, tz - cfHalf - 0.22, tx + tw / 2 + 0.22, cfY1 + 0.22, tz + cfHalf + 0.22, trimTiles, idx, { noAo: true });
      this.addVoxelBox(tx + tw / 2 + 0.16, cfY0, tz - cfHalf, tx + tw / 2 + 0.32, cfY1, tz + cfHalf, "vxClockFace", idx, { noAo: true });
      this.addVoxelBox(tx + tw / 2 + 0.30, cfMidY - 0.06, tz - 0.15, tx + tw / 2 + 0.42, cfY1 - 0.26, tz + 0.15, "vxClockHand", idx, { noAo: true });
      this.addVoxelBox(tx + tw / 2 + 0.30, cfMidY - 0.15, tz - 0.06, tx + tw / 2 + 0.42, cfMidY + 0.15, tz + cfHalf - 0.24, "vxClockHand", idx, { noAo: true });
      const cTop = tBase + th + 0.20;
      for (let s = 0; s < 4; s += 1) {
        const r = 2.35 - s * 0.50;
        const sy0 = cTop + s * 0.56;
        this.addVoxelBox(tx - r, sy0, tz - r, tx + r, sy0 + 0.58, tz + r, {
          top: s % 2 === 0 ? "vxRoofLight" : "vxRoofMid", front: "vxRoofDark", right: "vxRoofMid", back: "vxRoofDark", left: "vxRoofDark"
        }, idx, { noAo: true });
      }
      this.addVoxelBox(tx - 0.28, cTop + 2.26, tz - 0.28, tx + 0.28, cTop + 3.25, tz + 0.28, "vxLanternGold", idx, { noAo: true });
    }

    addCoarseMuseum(idx, V = 0.48) {
      const mx = -7.2, mz = -1.8, mw = 13.6, md = 11.4, mh = 8.4;
      const x0 = mx - mw / 2, x1 = mx + mw / 2;
      const z0 = mz - md / 2, z1 = mz + md / 2;
      const arcadeH = 3.85;
      const creamPal = VOXEL_PALETTES.cream;
      const ochrePal = VOXEL_PALETTES.ochre;
      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };

      this.addGroundShadow(mx, mz, mw, md, mh + 2.4, 0.22);

      const rec = 1.80;
      this.addVoxelBox(x0, 0, z0, x1 - rec, arcadeH, z1 - rec, {
        top: "vxCavityDeep", front: "vxCavityMid", right: "vxCavityMid", back: "vxBrickShade", left: "vxBrickShade"
      }, idx, { noTop: true });
      this.addVoxelBox(x0, arcadeH - 0.40, z1 - rec, x1, arcadeH, z1, "vxCavityDeep", idx, { noAo: true, withBottom: true });
      this.addVoxelBox(x1 - rec, arcadeH - 0.40, z0, x1, arcadeH, z1 - rec, "vxCavityDeep", idx, { noAo: true, withBottom: true });

      const sBays = 4;
      const sBayW = mw / sBays;
      const colW = Math.max(0.58, V * 1.34);
      for (let i = 0; i <= sBays; i += 1) {
        const px = x0 + i * sBayW;
        const cx0 = i === 0 ? px : (i === sBays ? px - colW : px - colW / 2);
        this.addVoxelBox(cx0, 0, z1 - 0.78, cx0 + colW, arcadeH, z1 + 0.08, trimTiles, idx);
      }
      this.addVoxelBox(x0 - 0.14, arcadeH - 0.62, z1 - 0.82, x1 + 0.16, arcadeH + 0.24, z1 + 0.26, trimTiles, idx, { noAo: true, withBottom: true });
      for (let i = 0; i < sBays; i += 1) {
        const bx0 = x0 + i * sBayW + colW * 0.55;
        const bx1 = x0 + (i + 1) * sBayW - colW * 0.55;
        const hW = Math.min((bx1 - bx0) * 0.25, V * 0.90);
        this.addVoxelBox(bx0, arcadeH - 1.12, z1 - 0.74, bx0 + hW, arcadeH - 0.58, z1 + 0.06, trimTiles, idx, { noAo: true, withBottom: true });
        this.addVoxelBox(bx1 - hW, arcadeH - 1.12, z1 - 0.74, bx1, arcadeH - 0.58, z1 + 0.06, trimTiles, idx, { noAo: true, withBottom: true });
        const dm = (bx0 + bx1) / 2;
        this.addVoxelBox(dm - 0.68, 0, z1 - rec - 0.06, dm + 0.68, 2.65, z1 - rec + 0.16, "vxCavityDoor", idx, { noAo: true });
      }

      const eBays = 3;
      const eBayD = md / eBays;
      for (let i = 0; i < eBays; i += 1) {
        const pz = z0 + i * eBayD;
        const cz0 = i === 0 ? pz : pz - colW / 2;
        this.addVoxelBox(x1 - 0.78, 0, cz0, x1 + 0.08, arcadeH, cz0 + colW, trimTiles, idx);
        const bz0 = pz + colW * 0.55;
        const bz1 = pz + eBayD - colW * 0.55;
        const hW = Math.min((bz1 - bz0) * 0.25, V * 0.90);
        this.addVoxelBox(x1 - 0.74, arcadeH - 1.12, bz0, x1 + 0.06, arcadeH - 0.58, bz0 + hW, trimTiles, idx, { noAo: true, withBottom: true });
        this.addVoxelBox(x1 - 0.74, arcadeH - 1.12, bz1 - hW, x1 + 0.06, arcadeH - 0.58, bz1, trimTiles, idx, { noAo: true, withBottom: true });
      }
      this.addVoxelBox(x1 - 0.82, arcadeH - 0.62, z0 - 0.10, x1 + 0.26, arcadeH + 0.24, z1 + 0.16, trimTiles, idx, { noAo: true, withBottom: true });

      this.addVoxelBox(x0, arcadeH, z0, x1 - 0.45, mh, z1 - 0.45, {
        top: "vxTrimShade", front: "vxCreamMid", right: "vxOchreMid", back: "vxBrickShade", left: "vxBrickShade"
      }, idx, { noAo: true });

      this.addCoarseVoxelUpperWall("z", z1, x0 + 0.04, mx - 0.06, arcadeH, mh, creamPal, 3, "manchuAmber", idx, V, false);
      this.addCoarseVoxelUpperWall("z", z1, mx + 0.06, x1 - 0.04, arcadeH, mh, ochrePal, 3, "manchuAmber", idx, V, false);
      this.addCoarseVoxelGable("z", z1, x0 + 0.08, mx - 0.12, mh + V * 0.20, 2.40, creamPal, "serratedCream", idx, V, false);
      this.addCoarseVoxelGable("z", z1, mx + 0.12, x1 - 0.08, mh + V * 0.20, 2.40, ochrePal, "arcOchre", idx, V, false);

      this.addCoarseVoxelUpperWall("x", x1, z0 + 0.06, z1 - 0.06, arcadeH, mh, creamPal, 3, "darkTeal", idx, V, false);
      this.addCoarseVoxelGable("x", x1, z0 + 0.20, z1 - 0.20, mh + V * 0.20, 1.80, creamPal, "steppedSemiMint", idx, V, false);

      this.addCoarseVoxelRoof(mx - mw * 0.24, mh + 0.12, mz - 0.35, mw * 0.45, 1.80, md - 1.1, "z", idx, creamPal, { north: true, south: false, west: false }, V, false);
      this.addCoarseVoxelRoof(mx + mw * 0.24, mh + 0.12, mz - 0.35, mw * 0.45, 1.80, md - 1.1, "z", idx, ochrePal, { north: true, south: false, west: false }, V, false);

      this.addCoarseUmbrellaTable(-2.2, 10.6, idx, V);
      this.addCoarseUmbrellaTable(3.2, 10.6, idx, V);
    }

    addCoarseShuibutou(idx, V = 0.48) {
      const stepTop = { top: "vxStoneTop", front: "vxStoneMid", right: "vxStoneLight", back: "vxStoneShade", left: "vxStoneShade" };
      const wallTiles = { top: "vxStoneTop", front: "vxStoneLight", right: "vxStoneMid", back: "vxStoneShade", left: "vxStoneShade" };
      const stepCount = 9;
      for (let step = 0; step < stepCount; step += 1) {
        const ratio = step / (stepCount - 1);
        const sy = 0.08 - ratio * 1.72;
        const sx = 8.9 + step * 0.72;
        const sw = 0.84;
        const sd = 10.8 - step * 0.54;
        this.addVoxelBox(sx - sw / 2, -1.85, 16.0 - sd / 2, sx + sw / 2, sy, 16.0 + sd / 2, stepTop, idx, { noAo: true });
      }
      this.addVoxelBox(14.95, -1.73, 12.6, 15.65, -1.58, 19.4, "vxWaterFoam", idx, { noAo: true });
      this.addVoxelBox(8.3, 0.0, 9.75, 13.0, 0.98, 10.75, wallTiles, idx, { noAo: true });
      this.addVoxelBox(8.3, 0.0, 21.25, 13.0, 0.98, 22.25, wallTiles, idx, { noAo: true });
      this.addVoxelBox(12.2, 0.96, 9.95, 12.82, 1.56, 10.55, "vxWoodDark", idx, { noAo: true });
      this.addVoxelBox(12.2, 0.96, 21.45, 12.82, 1.56, 22.05, "vxWoodDark", idx, { noAo: true });

      const bx = 20.4, bz = 17.4;
      this.addVoxelBox(bx - 3.7, -1.73, bz - 1.75, bx + 3.7, -1.62, bz + 1.75, "vxWaterFoam", idx, { noAo: true });
      this.addVoxelBox(bx - 3.3, -1.64, bz - 1.25, bx + 3.3, -1.04, bz + 1.25, {
        top: "vxWoodLight", front: "vxWoodDark", right: "vxWoodMid", back: "vxWoodDark", left: "vxWoodDark"
      }, idx, { noAo: true });
      this.addVoxelBox(bx - 3.65, -1.35, bz - 0.95, bx - 2.85, -0.78, bz + 0.95, "vxWoodMid", idx, { noAo: true });
      this.addVoxelBox(bx + 2.85, -1.35, bz - 0.95, bx + 3.65, -0.78, bz + 0.95, "vxWoodMid", idx, { noAo: true });
      this.addVoxelBox(bx - 2.05, -1.04, bz - 1.28, bx + 1.85, -0.44, bz + 1.28, {
        top: "vxCanopyLight", front: "vxCanopyShade", right: "vxCanopyShade", back: "vxCanopyShade", left: "vxCanopyShade"
      }, idx, { noAo: true });
      this.addVoxelBox(bx - 1.95, -0.44, bz - 0.84, bx + 1.75, 0.04, bz + 0.84, {
        top: "vxCanopyLight", front: "vxCanopyLight", right: "vxCanopyShade", back: "vxCanopyShade", left: "vxCanopyShade"
      }, idx, { noAo: true });
    }

    addCoarseXinshiSkybridge(idx, V = 0.48) {
      const trimTiles = { top: "vxTrimTop", front: "vxTrimFront", right: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", bottom: "vxTrimUnder" };
      const wallTiles = { top: "vxBrickLight", front: "vxBrickMid", right: "vxBrickLight", back: "vxBrickShade", left: "vxBrickShade" };
      this.addGroundShadow(-36.0, 31.3, 4.4, 7.8, 4.5, 0.16);
      this.addVoxelBox(-38.1, 0, 27.3, -33.9, 2.55, 29.1, wallTiles, idx, { noAo: true });
      this.addVoxelBox(-38.1, 0, 33.5, -33.9, 2.55, 35.3, wallTiles, idx, { noAo: true });
      this.addVoxelBox(-38.1, 1.95, 29.0, -33.9, 2.65, 29.9, trimTiles, idx, { noAo: true, withBottom: true });
      this.addVoxelBox(-38.1, 1.95, 32.7, -33.9, 2.65, 33.6, trimTiles, idx, { noAo: true, withBottom: true });
      this.addVoxelBox(-38.1, 2.55, 27.3, -33.9, 4.15, 35.3, wallTiles, idx, { noAo: true, withBottom: true });
      for (const wz of [30.2, 32.4]) {
        this.addVoxelBox(-34.0, 2.95, wz - 0.46, -33.82, 3.72, wz + 0.46, "vxWinDark", idx, { noAo: true });
        this.addVoxelBox(-38.18, 2.95, wz - 0.46, -38.0, 3.72, wz + 0.46, "vxWinDark", idx, { noAo: true });
      }
      this.addVoxelBox(-38.35, 4.05, 27.1, -33.65, 4.42, 35.5, trimTiles, idx, { noAo: true, withBottom: true });
      this.addCoarseVoxelRoof(-36.0, 4.40, 31.3, 4.3, 1.15, 8.2, "z", idx, VOXEL_PALETTES.grey, { north: true, south: true, west: false }, V, false);
    }

    addCoarseIronBridge(idx, V = 0.48) {
      const stoneMid = { top: "vxStoneLight", front: "vxStoneMid", right: "vxStoneMid", back: "vxStoneShade", left: "vxStoneShade" };
      const stoneDark = { top: "vxStoneShade", front: "vxStoneDark", right: "vxStoneDark", back: "vxStoneDark", left: "vxStoneDark" };
      const steelTop = { top: "vxSteelLight", front: "vxSteelMid", right: "vxSteelMid", back: "vxSteelDark", left: "vxSteelDark", bottom: "vxSteelDark" };
      const steelDark = { top: "vxSteelMid", front: "vxSteelDark", right: "vxSteelDark", back: "vxSteelDark", left: "vxSteelDark", bottom: "vxSteelDark" };

      this.addVoxelBox(-5.2, -1.8, 64.6, -0.6, 2.15, 70.4, stoneMid, idx, { noAo: true });
      this.addTexturedBox(24.5, 2.02, 67.5, 52.0, 0.68, 5.4, { top: "promenade", side: "vxSteelDark" }, idx, { topURep: 6, topVRep: 1, noAo: true });
      this.addVoxelBox(-1.5, 2.00, 64.55, 50.8, 2.68, 65.15, steelDark, idx, { noAo: true, withBottom: true });
      this.addVoxelBox(-1.5, 2.00, 69.85, 50.8, 2.68, 70.45, steelDark, idx, { noAo: true, withBottom: true });

      for (const px of [6.0, 24.5, 42.5]) {
        this.addVoxelBox(px - 1.55, -1.78, 64.3, px + 1.55, -1.56, 70.7, "vxWaterFoam", idx, { noAo: true });
        this.addVoxelBox(px - 1.25, -1.85, 64.6, px + 1.25, 0.35, 70.4, stoneDark, idx, { noAo: true });
        this.addVoxelBox(px - 1.02, 0.35, 64.8, px + 1.02, 2.02, 70.2, stoneMid, idx, { noAo: true });
      }

      const trussX0 = 2.0, trussX1 = 50.0;
      const bayCount = 8;
      const bayLen = (trussX1 - trussX0) / bayCount;
      const yBot = 2.66, yTop = 6.95;
      for (const tz of [64.85, 70.15]) {
        this.addVoxelBox(trussX0 + 1.4, yTop - 0.44, tz - 0.28, trussX1 - 1.4, yTop + 0.14, tz + 0.28, steelTop, idx, { noAo: true, withBottom: true });
        for (let bIdx = 0; bIdx <= bayCount; bIdx += 1) {
          const vx = trussX0 + bIdx * bayLen;
          if (bIdx > 0 && bIdx < bayCount) {
            this.addVoxelBox(vx - 0.24, yBot, tz - 0.24, vx + 0.24, yTop, tz + 0.24, steelTop, idx, { noAo: true });
          }
          if (bIdx < bayCount) {
            const xA = vx;
            const riseUp = bIdx % 2 === 0;
            const diagSteps = 4;
            for (let ds = 0; ds < diagSteps; ds += 1) {
              const t0 = ds / diagSteps;
              const t1 = (ds + 1) / diagSteps;
              const dx0 = xA + t0 * bayLen;
              const dx1 = xA + t1 * bayLen + 0.34;
              const dy0 = riseUp ? (yBot + t0 * (yTop - yBot - 0.4)) : (yTop - 0.4 - t1 * (yTop - yBot - 0.4));
              const dy1 = Math.min(yTop - 0.08, dy0 + 1.16);
              this.addVoxelBox(dx0, dy0, tz - 0.22, dx1, dy1, tz + 0.22, steelTop, idx, { noAo: true, withBottom: true });
            }
          }
        }
      }
      for (let bIdx = 1; bIdx < bayCount; bIdx += 1) {
        const vx = trussX0 + bIdx * bayLen;
        this.addVoxelBox(vx - 0.26, yTop - 0.36, 64.95, vx + 0.26, yTop + 0.10, 70.05, steelTop, idx, { noAo: true, withBottom: true });
      }
    }
  }

  // ── Build Full High-Density Pixel-Art Changdi 3D World ──────────────────
  function buildChangdiPixelWorld(voxelTier = "coarse") {
    const b = new PixelMeshBuilder();
    const tierKey = normalizeVoxelTier(voxelTier);
    const tierCfg = VOXEL_TIERS[tierKey] || VOXEL_TIERS.coarse;
    const isCoarseWorld = tierKey !== "orig";
    const V = tierCfg.voxelUnit;

    // 1. Ground & Pengjiang River (using real map-top.png river, plaza, and promenade textures!)
    // Inland stone base
    b.addQuad([-95, 0.0, -130], [-95, 0.0, 130], [8.5, 0.0, 130], [8.5, 0.0, -130], "promenade", 0, {
      uvA: [0, 0], uvB: [0, 26], uvC: [20, 26], uvD: [20, 0], flags: 2
    });
    // North promenade extension (stopping cleanly before Shuibutou steps at z = 10.5!)
    b.addQuad([8.5, 0.0, -110], [8.5, 0.0, 10.5], [14.2, 0.0, 10.5], [14.2, 0.0, -110], "promenade", 0, {
      uvA: [0, 0], uvB: [0, 14], uvC: [1.5, 14], uvD: [1.5, 0], flags: 2
    });
    // Pengjiang River turquoise pixel waves (flags = 1 enables subtle horizontal pixel drift!)
    b.addQuad([-5, -1.75, -135], [-5, -1.75, 135], [118, -1.75, 135], [118, -1.75, -135], "river", 0, {
      uvA: [0, 0], uvB: [0, 7.5], uvC: [4.2, 7.5], uvD: [4.2, 0], flags: 1
    });

    // Banyan Tree Square (warm peachy checkered tiles directly from map-top.png!)
    b.addQuad([-41, 0.04, -34.5], [-41, 0.04, -14.5], [-2.5, 0.04, -14.5], [-2.5, 0.04, -34.5], "plazaTile", 0, {
      uvA: [0, 0], uvB: [0, 2.4], uvC: [4.2, 2.4], uvD: [4.2, 0], flags: 2
    });
    // Warm stone street lanes (Museum / Didong / Xinshi / Xuding)
    b.addQuad([-46, 0.03, 27.5], [-46, 0.03, 66], [-23, 0.03, 66], [-23, 0.03, 27.5], "plazaTile", 0, {
      uvA: [0, 0], uvB: [0, 4.4], uvC: [2.6, 4.4], uvD: [2.6, 0], flags: 2
    });
    b.addQuad([-24, 0.03, 4.5], [-24, 0.03, 16.5], [9.5, 0.03, 16.5], [9.5, 0.03, 4.5], "promenade", 0, {
      uvA: [0, 0], uvB: [0, 1.8], uvC: [5.0, 1.8], uvD: [5.0, 0], flags: 2
    });

    if (isCoarseWorld) {
      b.addCoarseEmbankmentAndQuay(V);
    } else {
      b.addTexturedBox(14.0, -2.0, -49.5, 0.8, 2.05, 118, "embankment", 0, { uRepD: 14, noTop: true });
      b.addTexturedBox(8.2, -2.0, 43.0, 0.8, 2.05, 42, "embankment", 0, { uRepD: 6, noTop: true });
      for (let pz = -72; pz <= 9; pz += 6.2) {
        b.addTexturedBox(13.85, 0.0, pz, 0.65, 0.85, 0.65, "parapetTop", 0, { noAo: true });
      }
      for (let pz = 24; pz <= 63; pz += 6.2) {
        b.addTexturedBox(8.05, 0.0, pz, 0.65, 0.85, 0.65, "parapetTop", 0, { noAo: true });
      }
    }

    // ── LANDMARK 1: CD-R01 蓬江大桥 (Direct map.jpg arched stone bridge elevation!) ─
    {
      const idx = 1;
      if (isCoarseWorld) {
        b.addCoarsePengjiangBridge(idx, V);
      } else {
        b.addTexturedBox(31.5, 2.3, -65.5, 42.0, 0.72, 6.2, { top: "promenade", side: "parapetTop" }, idx, { topURep: 5, topVRep: 1 });
        b.addTexturedBox(12.2, 0.0, -65.5, 4.6, 2.3, 6.0, "parapetTop", idx);
        b.addQuad([12.0, -1.8, -62.35], [52.0, -1.8, -62.35], [52.0, 4.1, -62.35], [12.0, 4.1, -62.35], "pengjiangSide", idx, { flags: 3, doubleSided: true });
        b.addQuad([52.0, -1.8, -68.65], [12.0, -1.8, -68.65], [12.0, 4.1, -68.65], [52.0, 4.1, -68.65], "pengjiangSide", idx, { flags: 3, doubleSided: true });
        for (const pierX of [19.5, 31.5, 43.5]) {
          b.addTexturedBox(pierX, -1.9, -65.5, 2.2, 4.2, 6.0, "embankment", idx);
        }
      }
      b.addPickBox("CD-R01", 10, -1, -70, 52, 5.2, -61);
    }

    // ── LANDMARK 2: CD-V01 启明里 (Direct map.jpg archway gatehouse + brick village!) ─
    {
      const idx = 2;
      if (isCoarseWorld) {
        b.addCoarseQimingliGate(idx, V);
        b.addCoarseLingnanHouse(-43.0, -51.5, 9.2, 6.6, 3.9, 1.8, "x", idx, V);
        b.addCoarseLingnanHouse(-32.5, -54.0, 8.6, 6.4, 3.8, 1.7, "x", idx, V);
        b.addCoarseLingnanHouse(-43.5, -42.5, 8.2, 6.2, 3.7, 1.6, "z", idx, V);
        b.addCoarseVoxelTree(-38.0, -46.5, 0.95, idx, false, V);
        b.addCoarseVoxelTree(-26.5, -50.0, 0.9, idx, false, V);
      } else {
        b.addGroundShadow(-32.0, -45.5, 8.2, 2.2, 6.0, 0.18);
        b.addQuad([-36.0, 0, -44.6], [-28.0, 0, -44.6], [-28.0, 6.2, -44.6], [-36.0, 6.2, -44.6], "qimingliGate", idx, { doubleSided: true });
        b.addQuad([-28.0, 0, -46.4], [-36.0, 0, -46.4], [-36.0, 6.2, -46.4], [-28.0, 6.2, -46.4], "qimingliGate", idx, { doubleSided: true });
        b.addTexturedBox(-32.0, 5.6, -45.5, 8.0, 0.55, 1.8, "parapetTop", idx, { noAo: true });
        b.addLingnanHouse(-43.0, -51.5, 9.2, 6.6, 3.9, 1.8, "x", idx);
        b.addLingnanHouse(-32.5, -54.0, 8.6, 6.4, 3.8, 1.7, "x", idx);
        b.addLingnanHouse(-43.5, -42.5, 8.2, 6.2, 3.7, 1.6, "z", idx);
        b.addPixelTree(-38.0, -46.5, 0.95, idx);
        b.addPixelTree(-26.5, -50.0, 0.9, idx);
      }
      b.addPickBox("CD-V01", -49, 0, -58, -25, 6.8, -40);
    }

    // ── LANDMARK 3: CD-A02 江门海关旧址（示意）(Direct map.jpg colonnade + clock tower!) ─
    {
      const idx = 3;
      if (isCoarseWorld) {
        b.addCoarseCustomsHouse(idx, V);
      } else {
        const hx = -16.8, hz = -39.5, hw = 18.0, hd = 9.4, hh = 7.4;
        b.addGroundShadow(hx, hz, hw, hd, hh + 3.0, 0.18);
        b.addQuad([hx - hw / 2, 0, hz + hd / 2], [hx + hw / 2, 0, hz + hd / 2], [hx + hw / 2, hh, hz + hd / 2], [hx - hw / 2, hh, hz + hd / 2], "haiguanFront", idx, { ao: [0.88, 0.88, 1, 1] });
        b.addQuad([hx + hw / 2, 0, hz - hd / 2], [hx - hw / 2, 0, hz - hd / 2], [hx - hw / 2, hh, hz - hd / 2], [hx + hw / 2, hh, hz - hd / 2], "lingnanWall", idx, { uRep: 3 });
        b.addQuad([hx - hw / 2, 0, hz - hd / 2], [hx - hw / 2, 0, hz + hd / 2], [hx - hw / 2, hh, hz + hd / 2], [hx - hw / 2, hh, hz - hd / 2], "qilouCream", idx, { v0: 6 / 36, vRep: 30 / 36 });
        b.addQuad([hx + hw / 2, 0, hz + hd / 2], [hx + hw / 2, 0, hz - hd / 2], [hx + hw / 2, hh, hz - hd / 2], [hx + hw / 2, hh, hz + hd / 2], "qilouCream", idx, { v0: 6 / 36, vRep: 30 / 36 });
        b.addTexturedBox(hx, hh - 0.15, hz, hw + 0.3, 0.4, hd + 0.3, "parapetTop", idx, { noAo: true });
        b.addPitchedRoof(hx - 1.2, hh + 0.15, hz, hw - 2.6, 2.0, hd - 1.0, "x", idx, "parapetTop");
        b.addPixelQilou(-4.5, -40.0, 6.8, 11.2, 7.2, "+x", "qilouCream", idx, { bays: 1, southTile: "qilouCream" });
        const tx = -9.6, tz = -40.0;
        b.addTexturedBox(tx, hh, tz, 4.8, 5.4, 4.8, { top: "roofTile", side: "haiguanTower" }, idx, { noAo: true });
        b.addPitchedRoof(tx, hh + 5.3, tz, 4.2, 2.0, 4.2, "x", idx, "parapetTop");
        b.addTexturedBox(tx, hh + 7.1, tz, 0.45, 1.3, 0.45, "parapetTop", idx, { noAo: true });
      }
      b.addPickBox("CD-A02", -26.5, 0, -46.5, -0.5, 15.8, -33.5);
    }

    // Iconic Banyan Tree in Banyan Plaza (real map-top.png + map.jpg foliage sprites!)
    if (isCoarseWorld) {
      b.addVoxelBox(-33.1, 0, -27.6, -26.9, 0.68, -21.4, {
        top: "vxStoneTop", front: "vxStoneLight", right: "vxStoneLight", back: "vxStoneShade", left: "vxStoneShade"
      }, 0, { noAo: true });
      b.addVoxelBox(-32.4, 0.64, -26.9, -27.6, 0.80, -22.1, "vxLeafDeep", 0, { noAo: true });
      b.addCoarseVoxelTree(-30.0, -24.5, 1.35, 0, true, V);
      b.addCoarseVoxelTree(-11.0, -22.0, 0.9, 0, false, V);
      b.addCoarseVoxelTree(-4.0, -26.0, 0.85, 0, false, V);
    } else {
      b.addTexturedBox(-30.0, 0, -24.5, 6.2, 0.65, 6.2, "parapetTop", 0, { noAo: true });
      b.addPixelTree(-30.0, -24.5, 1.35, 0, true);
      b.addPixelTree(-11.0, -22.0, 0.9, 0);
      b.addPixelTree(-4.0, -26.0, 0.85, 0);
    }

    // ── LANDMARK 4: CD-A01 江门市博物馆长堤分馆 (Direct map.jpg Twin Qilou + Umbrellas!) ─
    {
      const idx = 4;
      if (isCoarseWorld) {
        b.addCoarseMuseum(idx, V);
      } else {
        const mx = -7.2, mz = -1.8, mw = 13.6, md = 11.4, mh = 8.4;
        b.addGroundShadow(mx, mz, mw, md, mh + 2.2, 0.18);
        b.addQuad([mx - mw / 2, 0, mz + md / 2], [mx + mw / 2, 0, mz + md / 2], [mx + mw / 2, mh + 1.8, mz + md / 2], [mx - mw / 2, mh + 1.8, mz + md / 2], "museumFront", idx, { flags: 3, doubleSided: true });
        b.addQuad([mx + mw / 2, 0, mz + md / 2], [mx + mw / 2, 0, mz - md / 2], [mx + mw / 2, mh, mz - md / 2], [mx + mw / 2, mh, mz + md / 2], "qilouCream", idx, { uRep: 2, v0: 6 / 36, vRep: 30 / 36, ao: [0.86, 0.86, 1, 1] });
        b.addQuad([mx + mw / 2 + 0.05, mh - 0.1, mz + md / 2], [mx + mw / 2 + 0.05, mh - 0.1, mz - md / 2], [mx + mw / 2 + 0.05, mh + 1.7, mz - md / 2], [mx + mw / 2 + 0.05, mh + 1.7, mz + md / 2], "qilouCream", idx, { uRep: 2, v0: 0, vRep: 6 / 36 + 0.02, flags: 3, doubleSided: true });
        b.addQuad([mx - mw / 2, 0, mz - md / 2], [mx - mw / 2, 0, mz + md / 2], [mx - mw / 2, mh, mz + md / 2], [mx - mw / 2, mh, mz - md / 2], "lingnanWall", idx, { uRep: 2 });
        b.addQuad([mx + mw / 2, 0, mz - md / 2], [mx - mw / 2, 0, mz - md / 2], [mx - mw / 2, mh, mz - md / 2], [mx + mw / 2, mh, mz - md / 2], "lingnanWall", idx, { uRep: 2 });
        b.addPitchedRoof(mx - mw * 0.24, mh, mz - 0.3, mw * 0.46, 1.75, md - 0.9, "z", idx, "parapetTop");
        b.addPitchedRoof(mx + mw * 0.24, mh, mz - 0.3, mw * 0.46, 1.75, md - 0.9, "z", idx, "parapetTop");
        b.addSampleUmbrellaTable(-2.2, 10.6, idx);
        b.addSampleUmbrellaTable(3.2, 10.6, idx);
      }
      b.addPickBox("CD-A01", -14.8, 0, -8.5, 5.5, 10.6, 11.2);
    }

    // ── LANDMARK 5: CD-A03 水埠头石阶 (9 unobstructed river steps + wooden sampan!) ─
    {
      const idx = 5;
      if (isCoarseWorld) {
        b.addCoarseShuibutou(idx, V);
      } else {
        const stepCount = 9;
        for (let step = 0; step < stepCount; step += 1) {
          const ratio = step / (stepCount - 1);
          const sy = 0.06 - ratio * 1.74;
          const sx = 8.9 + step * 0.72;
          const sw = 0.84;
          const sd = 10.8 - step * 0.54;
          b.addTexturedBox(sx, -1.85, 16.0, sw, sy + 1.85, sd, "stoneStep", idx, { noAo: true, topURep: 1, topVRep: 2 });
        }
        b.addTexturedBox(10.5, 0.0, 10.2, 4.4, 0.95, 0.9, "parapetTop", idx);
        b.addTexturedBox(10.5, 0.0, 21.8, 4.4, 0.95, 0.9, "parapetTop", idx);
        b.addTexturedBox(20.6, -1.72, 17.4, 6.4, 0.78, 2.5, "woodBoat", idx, { noAo: true });
        b.addPitchedRoof(20.4, -0.94, 17.4, 4.0, 1.0, 2.45, "x", idx, "umbrella");
        b.addQuad([18.4, -0.94, 18.62], [22.4, -0.94, 18.62], [22.4, 0.06, 17.4], [18.4, 0.06, 17.4], "umbrella", idx);
        b.addQuad([22.4, -0.94, 16.18], [18.4, -0.94, 16.18], [18.4, 0.06, 17.4], [22.4, 0.06, 17.4], "umbrella", idx);
      }
      b.addPickBox("CD-A03", 7.5, -1.8, 9.5, 24.8, 2.5, 23.0);
    }

    // ── LANDMARK 6: CD-S01 堤东路骑楼 (Pastel pink/mint/cream/ochre qilou + red lanterns!) ─
    {
      const idx = 6;
      if (tierKey === "orig") {
        b.addSampleArcadeShop({
          x0: -13.0, x1: -5.8, z0: 20.4, z1: 27.8,
          arcadeH: 3.7, bodyH: 7.9, gableH: 2.45, roofH: 1.82,
          upperTile: "sampleUpperCream", gableTile: "sampleGableCream",
          northTile: "sampleSideGrey", southTile: "samplePinkSide",
          archCount: 4, lanterns: true, pillarOrnaments: true,
          roofAxis: "z", steppedEnds: { north: true, south: false, west: false },
          cornerSouth: {
            archCount: 3,
            upperTile: "sampleUpperPink",
            gableTile: "sampleGablePink",
            gableH: 2.35,
            westEndTile: "samplePinkSide"
          },
          lid: idx
        });
        b.addSampleShopBox("shop1", "① 北转角红灯笼主铺", -13.0, 0, 20.4, -5.6, 10.35, 27.9);

        b.addGroundShadow(-15.1, 24.5, 4.2, 6.2, 7.2, 0.17);
        b.addTexturedBox(-15.1, 0, 24.5, 4.2, 6.9, 6.2, {
          top: "sampleParapet", front: "sampleMintSide", back: "sampleSideGrey",
          left: "sampleMintSide", right: "sampleSideGrey"
        }, idx);
        b.addTexturedBox(-15.1, 6.9, 27.45, 4.28, 0.52, 0.36, "sampleParapet", idx, { noAo: true, flags: 4 });
        b.addSampleBlockyRoof(-15.1, 6.95, 24.2, 3.8, 1.4, 5.4, "x", idx, "sampleSideGrey", { north: true, west: true });

        b.addGroundShadow(-19.1, 24.5, 3.8, 5.8, 6.8, 0.16);
        b.addTexturedBox(-19.1, 0, 24.5, 3.8, 6.65, 5.8, {
          top: "sampleParapet", front: "samplePinkSide", back: "sampleSideGrey",
          left: "sampleSideGrey", right: "sampleSideGrey"
        }, idx);
        b.addSampleBlockyRoof(-19.1, 6.7, 24.5, 3.5, 1.35, 5.4, "x", idx, "sampleSideGrey", { north: true, south: true, west: true });

        b.addGroundShadow(-24.0, 25.6, 6.0, 3.2, 4.8, 0.16);
        b.addQuad([-27.0, 0, 27.2], [-21.0, 0, 27.2], [-21.0, 5.1, 27.2], [-27.0, 5.1, 27.2], "sampleSkybridge", idx, { flags: 3, doubleSided: true });
        b.addQuad([-21.0, 0, 24.0], [-27.0, 0, 24.0], [-27.0, 5.1, 24.0], [-21.0, 5.1, 24.0], "sampleSkybridge", idx, { flags: 3, doubleSided: true });
        b.addTexturedBox(-24.0, 3.18, 25.6, 6.0, 0.42, 3.2, { top: "promenade", side: "sampleParapet" }, idx, { noAo: true, flags: 4 });
        b.addTexturedBox(-26.82, 0, 25.6, 0.36, 3.2, 3.16, "sampleParapet", idx, { flags: 4 });
        b.addTexturedBox(-24.0, 0, 25.6, 0.44, 3.2, 3.16, "sampleParapet", idx, { flags: 4 });
        b.addTexturedBox(-21.18, 0, 25.6, 0.36, 3.2, 3.16, "sampleParapet", idx, { flags: 4 });

        b.addSampleArcadeShop({
          x0: -12.8, x1: -5.8, z0: 30.8, z1: 35.4,
          arcadeH: 3.8, bodyH: 8.1, gableH: 2.55, roofH: 1.85,
          upperTile: "sampleUpperOchre", gableTile: "sampleGableOchre",
          northTile: "sampleSideGrey", southTile: "sampleSideGrey",
          archCount: 2, lanterns: false, pillarOrnaments: false,
          roofAxis: "x", steppedEnds: { north: true, south: true, west: true }, lid: idx
        });
        b.addTexturedBox(-9.5, 8.1, 30.92, 6.2, 0.40, 0.36, "sampleParapet", idx, { noAo: true, flags: 4 });
        b.addTexturedBox(-9.5, 8.1, 35.28, 6.2, 0.40, 0.36, "sampleParapet", idx, { noAo: true, flags: 4 });
        b.addSampleShopBox("shop2", "② 杏黄高挑弧顶铺", -12.8, 0, 30.8, -5.6, 10.65, 35.4);

        b.addSampleArcadeShop({
          x0: -12.8, x1: -5.8, z0: 35.4, z1: 40.0,
          arcadeH: 3.35, bodyH: 6.65, gableH: 2.05, roofH: 1.55,
          upperTile: "sampleUpperMint", gableTile: "sampleGableMint",
          northTile: "sampleSideGrey", southTile: "sampleSideGrey",
          archCount: 2, lanterns: false, pillarOrnaments: false,
          roofAxis: "x", steppedEnds: { north: false, south: true, west: true }, lid: idx
        });
        b.addSampleShopBox("shop3", "③ 薄荷阶梯半圆铺", -12.8, 0, 35.4, -5.6, 8.70, 40.0);

        b.addSampleArcadeShop({
          x0: -12.8, x1: -5.8, z0: 40.0, z1: 44.6,
          arcadeH: 3.35, bodyH: 6.65, gableH: 2.05, roofH: 1.55,
          upperTile: "sampleUpperCoral", gableTile: "sampleGableWave",
          northTile: "sampleSideGrey", southTile: "sampleSideGrey",
          archCount: 2, lanterns: false, pillarOrnaments: false,
          roofAxis: "x", steppedEnds: { north: false, south: true, west: true }, lid: idx
        });
        b.addTexturedBox(-9.5, 6.65, 44.48, 6.2, 0.40, 0.36, "sampleParapet", idx, { noAo: true, flags: 4 });
        b.addSampleShopBox("shop4", "④ 珊瑚粉波浪铺", -12.8, 0, 40.0, -5.6, 8.70, 44.6);

        // Exact 8941 baseline measurement segments (same locations as coarse tiers)
        const origGableStepH = 2.55 / 28;
        const origGableStepW = 4.6 / 32;
        const origUpperTexH = 4.3 / 30;
        b.addMeasureSegment("gableStepH", "山花单阶高", [-5.74, 8.7, 32.0], [-5.74, 8.7 + origGableStepH, 32.0], origGableStepH, "8941平面镂空贴图1格");
        b.addMeasureSegment("gableStepW", "山花单阶退台宽", [-5.74, 8.7, 31.4], [-5.74, 8.7, 31.4 + origGableStepW], origGableStepW, "8941平面镂空贴图1格");
        b.addMeasureSegment("corniceH", "主檐口厚度", [-5.8, 7.96, 33.1], [-5.8, 8.26, 33.1], 0.30, "8941平齐檐条高");
        b.addMeasureSegment("corniceOverhang", "主檐口出挑", [-5.8, 8.1, 33.1], [-5.74, 8.1, 33.1], 0.06, "8941几乎无实体出挑");
        b.addMeasureSegment("eaveShadowH", "檐下阴影带高", [-5.8, 8.1 - origUpperTexH, 33.1], [-5.8, 8.1, 33.1], origUpperTexH, "8941立面贴图1格阴影线");
        b.addMeasureSegment("windowW", "窗洞净宽", [-5.8, 5.95, 31.66], [-5.8, 5.95, 32.67], 1.01, "8941平面贴图窗宽");
        b.addMeasureSegment("windowSillH", "窗台/过梁厚", [-5.8, 5.0, 32.16], [-5.8, 5.0 + origUpperTexH, 32.16], origUpperTexH, "8941平面贴图1格窗台");
        b.addMeasureSegment("lanternBodyW", "灯笼主体宽", [-5.33, 2.44, 21.32 - 0.39], [-5.33, 2.44, 21.32 + 0.39], 0.78, "8941微细条纹方体");
        b.addMeasureSegment("lanternCoreW", "灯笼高光芯宽", [-5.33, 2.44, 21.32 - 0.11], [-5.33, 2.44, 21.32 + 0.11], 0.22, "8941贴图4格细亮条");
        b.addMeasureSegment("roofStepH", "屋面瓦阶高", [-9.65, 8.18, 35.28], [-9.65, 8.18, 35.28], 0.0, "8941平整斜坡无实体台阶");
        b.addMeasureSegment("ridgeCapW", "屋脊压顶宽", [-9.65, 10.33, 33.1 - 0.28], [-9.65, 10.33, 33.1 + 0.28], 0.56, "8941屋脊条宽");
      } else {
        const V = tierCfg.voxelUnit;
        b.addCoarseSampleArcadeShop({
          x0: -13.0, x1: -5.8, z0: 20.4, z1: 27.8,
          arcadeH: 3.7, bodyH: 7.9, gableH: 2.45, roofH: 1.82,
          palKey: "cream", gableStyle: "serratedCream", winStyle: "manchuAmber",
          archCount: 4, lanterns: true, pillarOrnaments: true,
          roofAxis: "z", steppedEnds: { north: true, south: false, west: false },
          cornerSouth: {
            archCount: 3,
            palKey: "pink",
            gableStyle: "serratedPink",
            winStyle: "darkTeal",
            gableH: 2.35
          },
          lid: idx
        }, V, false, true);
        b.addSampleShopBox("shop1", "① 北转角红灯笼主铺", -13.0, 0, 20.4, -5.3, 10.55, 28.2);

        // Rear mint bay attached to Shop ① (same world voxel scale V)
        b.addGroundShadow(-15.1, 24.5, 4.2, 6.2, 7.2, 0.18);
        b.addVoxelBox(-17.2, 0, 21.4, -13.0, 6.9, 27.6, {
          top: "vxTrimShade", front: "vxMintMid", back: "vxGreyMid", left: "vxMintShade", right: "vxGreyShade"
        }, idx);
        b.addVoxelBox(-17.24, 6.9 - V * 0.4, 27.15, -12.96, 6.9 + V * 1.15, 27.6 + V * 0.45, {
          top: "vxTrimTop", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront", bottom: "vxTrimUnder"
        }, idx, { noAo: true, withBottom: true });
        // Chunky recessed window on rear mint bay south wall
        b.addVoxelBox(-15.8, 3.2, 27.42, -14.4, 5.2, 27.64, "vxWinDark", idx, { noAo: true });
        b.addVoxelBox(-15.6, 3.4, 27.46, -14.6, 5.0, 27.62, "vxGlassTeal", idx, { noAo: true });
        b.addVoxelBox(-15.95, 2.95, 27.50, -14.25, 3.25, 27.85, { top: "vxTrimTop", front: "vxTrimFront", bottom: "vxTrimUnder", side: "vxTrimShade" }, idx, { noAo: true, withBottom: true });
        b.addCoarseVoxelRoof(-15.1, 6.95, 24.2, 3.8, 1.4, 5.4, "x", idx, VOXEL_PALETTES.grey, { north: true, west: true }, V, false);

        // Rear pink bay attached to Shop ① (same world voxel scale V)
        b.addGroundShadow(-19.1, 24.5, 3.8, 5.8, 6.8, 0.17);
        b.addVoxelBox(-21.0, 0, 21.6, -17.2, 6.65, 27.4, {
          top: "vxTrimShade", front: "vxPinkMid", back: "vxGreyMid", left: "vxGreyShade", right: "vxGreyShade"
        }, idx);
        b.addVoxelBox(-21.04, 6.65 - V * 0.35, 27.0, -17.16, 6.65 + V * 0.65, 27.4 + V * 0.45, {
          top: "vxTrimTop", front: "vxTrimFront", back: "vxTrimShade", left: "vxTrimShade", right: "vxTrimFront", bottom: "vxTrimUnder"
        }, idx, { noAo: true, withBottom: true });
        for (const wx of [-20.1, -19.1, -18.1]) {
          b.addVoxelBox(wx - V * 0.65, 3.2, 27.28, wx + V * 0.65, 4.9, 27.46, "vxWinDark", idx, { noAo: true });
          b.addVoxelBox(wx - V * 0.72, 2.95, 27.36, wx + V * 0.72, 3.22, 27.64, { top: "vxTrimTop", front: "vxTrimFront", side: "vxTrimShade", bottom: "vxTrimUnder" }, idx, { noAo: true, withBottom: true });
        }
        b.addCoarseVoxelRoof(-19.1, 6.7, 24.5, 3.5, 1.35, 5.4, "x", idx, VOXEL_PALETTES.grey, { north: true, south: true, west: true }, V, false);

        // Real 3D chunky voxel skybridge linking Shop ① westwards
        b.addGroundShadow(-24.0, 25.6, 6.0, 3.2, 4.8, 0.16);
        b.addCoarseSampleSkybridge(-27.0, -21.0, 24.0, 27.2, 3.18, 5.1, idx, V);

        b.addCoarseSampleArcadeShop({
          x0: -12.8, x1: -5.8, z0: 30.8, z1: 35.4,
          arcadeH: 3.8, bodyH: 8.1, gableH: 2.55, roofH: 1.85,
          palKey: "ochre", gableStyle: "serratedOchre", winStyle: "manchuAmber",
          archCount: 2, lanterns: false, pillarOrnaments: false,
          roofAxis: "x", steppedEnds: { north: true, south: true, west: true }, lid: idx
        }, V, true, false);
        b.addSampleShopBox("shop2", "② 杏黄高挑弧顶铺", -12.8, 0, 30.8, -5.3, 10.85, 35.4);

        b.addCoarseSampleArcadeShop({
          x0: -12.8, x1: -5.8, z0: 35.4, z1: 40.0,
          arcadeH: 3.35, bodyH: 6.65, gableH: 2.05, roofH: 1.55,
          palKey: "mint", gableStyle: "steppedSemiMint", winStyle: "cyanGreen",
          archCount: 2, lanterns: false, pillarOrnaments: false,
          roofAxis: "x", steppedEnds: { north: false, south: true, west: true }, lid: idx
        }, V, false, false);
        b.addSampleShopBox("shop3", "③ 薄荷阶梯半圆铺", -12.8, 0, 35.4, -5.3, 8.90, 40.0);

        b.addCoarseSampleArcadeShop({
          x0: -12.8, x1: -5.8, z0: 40.0, z1: 44.6,
          arcadeH: 3.35, bodyH: 6.65, gableH: 2.05, roofH: 1.55,
          palKey: "pink", gableStyle: "waveCoral", winStyle: "cyanGreen",
          archCount: 2, lanterns: false, pillarOrnaments: false,
          roofAxis: "x", steppedEnds: { north: false, south: true, west: true }, lid: idx
        }, V, false, false);
        b.addSampleShopBox("shop4", "④ 珊瑚粉波浪铺", -12.8, 0, 40.0, -5.3, 8.90, 44.6);
      }

      if (isCoarseWorld) {
        b.addCoarseVoxelTree(-11.0, 17.2, 1.06, idx, false, V);
        b.addCoarseVoxelTree(-7.4, 16.8, 1.18, idx, false, V);
        b.addCoarseVoxelTree(-4.4, 17.6, 0.98, idx, false, V);
        b.addCoarseVoxelTree(2.2, 37.0, 1.02, idx, false, V);
        b.addCoarseVoxelTree(-16.2, 45.6, 1.16, idx, false, V);
        b.addCoarseMarketStall(-22.8, 34.0, false, idx, V);
      } else {
        b.addSampleTreeWithShadow(-11.0, 17.2, 1.10, idx);
        b.addSampleTreeWithShadow(-7.4, 16.8, 1.22, idx);
        b.addSampleTreeWithShadow(-4.4, 17.6, 1.02, idx);
        b.addSampleTreeWithShadow(2.2, 37.0, 1.04, idx);
        b.addSampleTreeWithShadow(-15.6, 45.4, 1.26, idx);
        b.addMarketStall(-22.8, 34.0, "stallCream", idx);
      }
      // Inner south-facing qilou bay linking to Xinshi Road
      b.addPickBox("CD-S01", -27.2, 0, 19.8, -5.4, 10.8, 45.0);
    }

    // ── LANDMARK 7: CD-S02 新市路 (Historic shophouse alley + arched sky-bridge!) ─
    {
      const idx = 7;
      if (isCoarseWorld) {
        b.addCoarseLingnanHouse(-42.5, 24.2, 9.4, 6.0, 4.0, 1.7, "x", idx, V);
        b.addCoarseLingnanHouse(-31.8, 24.2, 8.8, 6.0, 4.1, 1.7, "x", idx, V);
        b.addCoarseLingnanHouse(-42.5, 38.0, 9.2, 6.0, 4.0, 1.6, "x", idx, V);
        b.addCoarseLingnanHouse(-31.5, 38.0, 8.6, 6.0, 3.8, 1.6, "x", idx, V);
        b.addCoarseXinshiSkybridge(idx, V);
      } else {
        b.addLingnanHouse(-42.5, 24.2, 9.4, 6.0, 4.0, 1.7, "x", idx);
        b.addLingnanHouse(-31.8, 24.2, 8.8, 6.0, 4.1, 1.7, "x", idx);
        b.addLingnanHouse(-42.5, 38.0, 9.2, 6.0, 4.0, 1.6, "x", idx);
        b.addLingnanHouse(-31.5, 38.0, 8.6, 6.0, 3.8, 1.6, "x", idx);
        b.addQuad([-38.0, 0, 31.2], [-34.0, 0, 31.2], [-34.0, 4.1, 31.2], [-38.0, 4.1, 31.2], "xinshiBridge", idx, { flags: 3, doubleSided: true });
        b.addQuad([-38.0, 0, 27.6], [-38.0, 0, 35.0], [-38.0, 4.1, 35.0], [-38.0, 4.1, 27.6], "xinshiBridge", idx, { flags: 3, doubleSided: true });
        b.addQuad([-34.0, 0, 35.0], [-34.0, 0, 27.6], [-34.0, 4.1, 27.6], [-34.0, 4.1, 35.0], "xinshiBridge", idx, { flags: 3, doubleSided: true });
        b.addTexturedBox(-36.0, 3.5, 31.3, 4.1, 0.55, 7.6, "parapetTop", idx, { noAo: true });
      }
      b.addPickBox("CD-S02", -48.5, 0, 21.0, -25.5, 6.4, 41.5);
    }

    // ── LANDMARK 8: CD-S03 墟顶老街 (Old market street + striped pixel stalls!) ─
    {
      const idx = 8;
      if (isCoarseWorld) {
        b.addCoarseLingnanHouse(-43.0, 46.8, 8.8, 6.4, 4.0, 1.6, "z", idx, V);
        b.addCoarseLingnanHouse(-43.0, 55.2, 8.8, 6.8, 3.8, 1.6, "z", idx, V);
        b.addCoarseLingnanHouse(-25.5, 49.0, 7.4, 6.6, 3.9, 1.6, "z", idx, V);
        b.addCoarseLingnanHouse(-25.5, 57.5, 7.4, 6.8, 3.7, 1.6, "z", idx, V);
        b.addCoarseMarketStall(-35.2, 48.8, false, idx, V);
        b.addCoarseMarketStall(-35.2, 55.6, true, idx, V);
        b.addCoarseVoxelTree(-31.0, 62.8, 1.20, idx, false, V);
      } else {
        b.addLingnanHouse(-43.0, 46.8, 8.8, 6.4, 4.0, 1.6, "z", idx);
        b.addLingnanHouse(-43.0, 55.2, 8.8, 6.8, 3.8, 1.6, "z", idx);
        b.addLingnanHouse(-25.5, 49.0, 7.4, 6.6, 3.9, 1.6, "z", idx);
        b.addLingnanHouse(-25.5, 57.5, 7.4, 6.8, 3.7, 1.6, "z", idx);
        b.addMarketStall(-35.2, 48.8, "stallCream", idx);
        b.addMarketStall(-35.2, 55.6, "stallGreen", idx);
        b.addPixelTree(-31.0, 62.8, 1.25, idx);
      }
      b.addPickBox("CD-S03", -48.5, 0, 43.0, -21.5, 6.4, 65.0);
    }

    // ── LANDMARK 9: CD-P01 沿江停车场（示范）(Riverside parking + 3 pastel cars!) ─
    {
      const idx = 9;
      if (isCoarseWorld) {
        b.addVoxelBox(-4.4, 0.0, 51.0, 7.4, 0.18, 64.0, {
          top: "vxParkingPad", front: "vxStoneMid", right: "vxStoneMid", back: "vxStoneShade", left: "vxStoneShade"
        }, idx, { noAo: true });
        for (const lz of [51.4, 55.5, 59.5, 63.6]) {
          b.addVoxelBox(-1.4, 0.17, lz - 0.14, 6.4, 0.24, lz + 0.14, "vxParkingLine", idx, { noAo: true });
        }
        b.addCoarseCar(2.2, 53.5, "vxCarWhite", idx);
        b.addCoarseCar(2.2, 57.5, "vxCarBlue", idx);
        b.addCoarseCar(2.2, 61.5, "vxCarYellow", idx);
        b.addCoarseVoxelTree(-3.4, 50.8, 0.88, idx, false, V);
        b.addCoarseVoxelTree(-4.2, 62.6, 0.80, idx, false, V);
      } else {
        b.addTexturedBox(1.5, 0.0, 57.5, 11.8, 0.16, 13.0, { top: "parkingPad", side: "parapetTop" }, idx, { noAo: true });
        b.addCar(2.2, 53.5, "carWhite", idx);
        b.addCar(2.2, 57.5, "carBlue", idx);
        b.addCar(2.2, 61.5, "carYellow", idx);
        b.addPixelTree(-3.4, 50.8, 0.9, idx);
        b.addPixelTree(-4.2, 62.6, 0.8, idx);
      }
      b.addPickBox("CD-P01", -5.0, 0, 50.0, 8.2, 3.4, 64.5);
    }

    // ── LANDMARK 10: CD-R02 江门铁桥 (Direct map.jpg steel Warren truss bridge!) ─
    {
      const idx = 10;
      if (isCoarseWorld) {
        b.addCoarseIronBridge(idx, V);
      } else {
        b.addTexturedBox(24.5, 2.0, 67.5, 52.0, 0.72, 5.4, { top: "promenade", side: "embankment" }, idx, { topURep: 6, topVRep: 1 });
        b.addTexturedBox(-3.0, 0.0, 67.5, 4.5, 2.0, 5.4, "parapetTop", idx);
        for (const pierX of [6.0, 24.5, 42.5]) {
          b.addTexturedBox(pierX, -1.9, 67.5, 2.2, 3.9, 5.6, "embankment", idx);
        }
        b.addQuad([2.0, 2.4, 70.1], [50.0, 2.4, 70.1], [50.0, 7.6, 70.1], [2.0, 7.6, 70.1], "ironTruss", idx, { flags: 3, doubleSided: true });
        b.addQuad([50.0, 2.4, 64.9], [2.0, 2.4, 64.9], [2.0, 7.6, 64.9], [50.0, 7.6, 64.9], "ironTruss", idx, { flags: 3, doubleSided: true });
        for (let cx = 6; cx <= 46; cx += 6.5) {
          b.addTexturedBox(cx, 6.8, 67.5, 0.45, 0.35, 5.2, "ridgeCap", idx, { noAo: true });
        }
      }
      b.addPickBox("CD-R02", -3, -1, 63.5, 51, 7.8, 71.5);
    }

    // ── HIGH-DENSITY CONTEXT STREETSCAPE (Matching map.jpg / map-top.png density!) ─
    // Continuous colorful waterfront qilou row (north of Customs & between Customs/Museum & south of Didong)
    if (isCoarseWorld) {
      const contextQilous = [
        { x0: -1.4, x1: 6.4, z0: -66.4, z1: -58.4, arcadeH: 3.4, bodyH: 6.9, gableH: 2.05, roofH: 1.65, palKey: "ochre", gableStyle: "arcOchre", winStyle: "manchuAmber", archCount: 3, steppedEnds: { north: true, south: false, west: true } },
        { x0: -1.4, x1: 6.4, z0: -58.4, z1: -50.4, arcadeH: 3.4, bodyH: 7.2, gableH: 2.15, roofH: 1.70, palKey: "pink", gableStyle: "waveCoral", winStyle: "cyanGreen", archCount: 3, steppedEnds: { north: false, south: false, west: true } },
        { x0: -1.4, x1: 6.4, z0: -50.4, z1: -42.4, arcadeH: 3.4, bodyH: 6.9, gableH: 2.05, roofH: 1.65, palKey: "cream", gableStyle: "serratedCream", winStyle: "darkTeal", archCount: 3, steppedEnds: { north: false, south: true, west: true } },
        { x0: -1.3, x1: 6.3, z0: -35.8, z1: -27.6, arcadeH: 3.4, bodyH: 7.1, gableH: 2.10, roofH: 1.68, palKey: "ochre", gableStyle: "arcOchre", winStyle: "manchuAmber", archCount: 3, steppedEnds: { north: true, south: false, west: true } },
        { x0: -1.3, x1: 6.3, z0: -27.6, z1: -19.4, arcadeH: 3.4, bodyH: 7.3, gableH: 2.15, roofH: 1.72, palKey: "pink", gableStyle: "waveCoral", winStyle: "cyanGreen", archCount: 3, steppedEnds: { north: false, south: false, west: true } },
        { x0: -1.3, x1: 6.3, z0: -19.4, z1: -11.2, arcadeH: 3.4, bodyH: 7.0, gableH: 2.05, roofH: 1.65, palKey: "mint", gableStyle: "steppedSemiMint", winStyle: "cyanGreen", archCount: 3, steppedEnds: { north: false, south: true, west: true } },
        { x0: -13.0, x1: -5.9, z0: 44.6, z1: 50.8, arcadeH: 3.35, bodyH: 6.85, gableH: 2.05, roofH: 1.58, palKey: "cream", gableStyle: "serratedCream", winStyle: "manchuAmber", archCount: 2, steppedEnds: { north: false, south: true, west: true } },
        { x0: -14.0, x1: -6.9, z0: 50.8, z1: 57.8, arcadeH: 3.35, bodyH: 6.75, gableH: 2.05, roofH: 1.56, palKey: "mint", gableStyle: "steppedSemiMint", winStyle: "cyanGreen", archCount: 2, steppedEnds: { north: false, south: true, west: true } },
        { x0: -15.2, x1: -8.1, z0: 57.8, z1: 65.0, arcadeH: 3.35, bodyH: 6.95, gableH: 2.10, roofH: 1.60, palKey: "pink", gableStyle: "waveCoral", winStyle: "darkTeal", archCount: 2, steppedEnds: { north: false, south: true, west: true } }
      ];
      for (const qCfg of contextQilous) {
        b.addCoarseSampleArcadeShop({
          ...qCfg,
          lanterns: false,
          pillarOrnaments: false,
          roofAxis: "x",
          lid: 0
        }, V, false, false);
      }
    } else {
      b.addPixelQilou(2.5, -62.5, 7.8, 7.8, 7.2, "+x", "qilouOchre", 0);
      b.addPixelQilou(2.5, -54.4, 7.8, 7.8, 7.4, "+x", "qilouPink", 0);
      b.addPixelQilou(2.5, -46.3, 7.8, 7.8, 7.2, "+x", "qilouCream", 0);
      b.addPixelQilou(2.5, -31.8, 7.6, 8.0, 7.4, "+x", "qilouOchre", 0);
      b.addPixelQilou(2.5, -23.5, 7.6, 8.0, 7.6, "+x", "qilouPink", 0);
      b.addPixelQilou(2.5, -15.2, 7.6, 8.0, 7.4, "+x", "qilouMint", 0);
      b.addPixelQilou(-12.5, 50.4, 8.8, 7.6, 7.2, "+x", "qilouCream", 0);
      b.addPixelQilou(-12.5, 58.3, 8.8, 7.6, 7.0, "+x", "qilouMint", 0);
      b.addPixelQilou(-13.0, 66.8, 8.6, 7.6, 7.2, "+x", "qilouPink", 0);
    }

    // Tight overlapping rows of Lingnan pitched-roof brick houses (filling west & north blocks cleanly!)
    const denseBlocks = [
      [-44, -69, 9.6, 6.4, 3.8, 1.6, "x"], [-33, -69, 10.0, 6.4, 4.0, 1.7, "x"],
      [-21, -68, 10.0, 6.8, 4.1, 1.7, "x"], [-9, -67, 9.4, 6.6, 3.9, 1.6, "z"],
      [-44, -61, 9.2, 6.0, 3.7, 1.6, "x"], [-21, -58, 9.8, 6.2, 3.9, 1.6, "x"],
      [-10, -57, 9.2, 6.2, 3.8, 1.6, "x"], [-21, -50, 9.6, 5.8, 3.8, 1.5, "x"],
      [-45, -34, 7.6, 7.2, 3.7, 1.5, "z"], [-45, -26, 7.6, 7.6, 3.8, 1.5, "z"],
      [-45, -17, 7.6, 7.6, 3.7, 1.5, "z"], [-44, -8, 9.4, 6.6, 4.0, 1.7, "x"],
      [-33, -8, 9.6, 6.6, 3.9, 1.6, "x"], [-22, -8, 8.2, 6.4, 3.8, 1.6, "x"],
      [-44, 0, 9.4, 6.4, 3.8, 1.6, "x"], [-33, 0, 9.6, 6.4, 4.0, 1.6, "x"],
      [-44, 9, 9.4, 6.6, 3.9, 1.6, "x"], [-33, 9, 9.2, 6.6, 3.7, 1.5, "x"],
      [-44, 17, 9.4, 6.2, 3.8, 1.6, "x"], [-33, 17, 9.0, 6.2, 3.9, 1.6, "x"],
      [-21, 17, 7.2, 5.8, 3.8, 1.5, "x"], [-44, 65, 9.6, 7.0, 3.8, 1.6, "x"],
      [-33, 67, 9.0, 6.6, 3.7, 1.5, "x"], [-22, 67, 8.0, 6.4, 3.8, 1.6, "z"]
    ];
    for (const [bx, bz, bw, bd, wh, rh, ax] of denseBlocks) {
      if (isCoarseWorld) {
        b.addCoarseLingnanHouse(bx, bz, bw, bd, wh, rh, ax, 0, V);
      } else {
        b.addLingnanHouse(bx, bz, bw, bd, wh, rh, ax, 0);
      }
    }

    // Lush pixel-art courtyard & street trees (matching map-top.png & map.jpg greenery density!)
    const contextTrees = [
      [-18, -63, 1.45], [-12, -70, 1.2], [-26, -60, 1.1], [-39, -35, 0.9],
      [-26, -13, 1.05], [-34, -14, 0.95], [-24, 3, 0.95],
      [-38, 43, 0.95], [-46, 60, 0.9], [-19, 46, 1.0], [9.0, -70, 0.9],
      [-16, -26, 0.85], [-37, -14, 0.85]
    ];
    for (const [tx, tz, ts] of contextTrees) {
      if (isCoarseWorld) {
        b.addCoarseVoxelTree(tx, tz, ts, 0, false, V);
      } else {
        b.addPixelTree(tx, tz, ts, 0, false);
      }
    }

    // Tiny strolling pixel pedestrians along riverside promenade, Banyan plaza, and Xuding lane
    const people = [
      [10.8, -56, "pedestrianB"], [10.6, -42, "pedestrianA"], [10.4, -28, "pedestrianC"],
      [10.2, -10, "pedestrianA"], [9.5, 4, "pedestrianB"], [5.8, 14, "pedestrianA"],
      [4.2, 30, "pedestrianB"], [4.0, 44, "pedestrianC"], [-18, -26, "pedestrianA"],
      [-24, -19, "pedestrianB"], [-21, -19, "pedestrianC"], [-34, 44, "pedestrianA"],
      [-33, 52, "pedestrianB"], [-36, 60, "pedestrianC"]
    ];
    for (const [px, pz, pt] of people) {
      if (isCoarseWorld) {
        const shirtSlot = pt === "pedestrianB" ? "vxPedShirtB" : (pt === "pedestrianC" ? "vxPedShirtC" : "vxPedShirtA");
        b.addCoarsePedestrian(px, pz, shirtSlot);
      } else {
        b.addPedestrian(px, pz, pt);
      }
    }

    return {
      opaque: new Float32Array(b.opaque),
      opaqueCount: b.opaque.length / 16,
      cutout: new Float32Array(b.cutout),
      cutoutCount: b.cutout.length / 16,
      shadows: new Float32Array(b.shadows),
      shadowCount: b.shadows.length / 4,
      pickBoxes: b.pickBoxes,
      sampleShopBoxes: b.sampleShopBoxes,
      sampleMeasureSegments: b.sampleMeasureSegments,
      voxelTier: tierKey,
      voxelUnit: tierCfg.voxelUnit
    };
  }

  // ── Build 3D Street-Hugging Route Ribbon Mesh ───────────────────────────
  function buildRouteMesh(routes, nowMs) {
    const verts = [];
    for (const route of routes) {
      if (!route.worldPoints || route.worldPoints.length < 2) continue;
      const rgb = hexToRgb(route.color || "#b23a2a");
      const halfW = route.active ? 0.72 : 0.48;
      const yBase = route.active ? 0.34 : 0.28;
      const progress = route.durationMs > 0
        ? easeInOutCubic(clamp((nowMs - route.startMs) / route.durationMs, 0, 1))
        : 1;

      const pts = route.worldPoints;
      const lengths = [0];
      let totalLen = 0;
      for (let idx = 1; idx < pts.length; idx += 1) {
        totalLen += Math.hypot(pts[idx][0] - pts[idx - 1][0], pts[idx][1] - pts[idx - 1][1]);
        lengths.push(totalLen);
      }
      const maxDrawLen = totalLen * progress;
      if (maxDrawLen < 0.05) continue;

      const drawSegments = [];
      for (let idx = 1; idx < pts.length; idx += 1) {
        const prevLen = lengths[idx - 1];
        const segLen = lengths[idx] - prevLen;
        if (segLen < 1e-4) continue;
        if (prevLen >= maxDrawLen) break;
        const frac = clamp((maxDrawLen - prevLen) / segLen, 0, 1);
        const p0 = pts[idx - 1];
        const p1 = [lerp(p0[0], pts[idx][0], frac), lerp(p0[1], pts[idx][1], frac)];
        drawSegments.push([p0, p1]);
      }

      const pushQuad = (a, b, c, d, col, alpha) => {
        const p = pt => verts.push(pt[0], pt[1], pt[2], col[0], col[1], col[2], alpha);
        p(a); p(b); p(c); p(a); p(c); p(d);
      };

      const casingRgb = hexToRgb("#fbf4e4");
      for (const [p0, p1] of drawSegments) {
        const dx = p1[0] - p0[0];
        const dz = p1[1] - p0[1];
        const len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len;
        const nz = dx / len;
        const ex = dx / len * (halfW * 0.45);
        const ez = dz / len * (halfW * 0.45);
        const cw = halfW + 0.3;
        pushQuad(
          [p0[0] - ex + nx * cw, yBase - 0.03, p0[1] - ez + nz * cw],
          [p0[0] - ex - nx * cw, yBase - 0.03, p0[1] - ez - nz * cw],
          [p1[0] + ex - nx * cw, yBase - 0.03, p1[1] + ez - nz * cw],
          [p1[0] + ex + nx * cw, yBase - 0.03, p1[1] + ez + nz * cw],
          casingRgb, 0.94
        );
        pushQuad(
          [p0[0] - ex * 0.6 + nx * halfW, yBase, p0[1] - ez * 0.6 + nz * halfW],
          [p0[0] - ex * 0.6 - nx * halfW, yBase, p0[1] - ez * 0.6 - nz * halfW],
          [p1[0] + ex * 0.6 - nx * halfW, yBase, p1[1] + ez * 0.6 - nz * halfW],
          [p1[0] + ex * 0.6 + nx * halfW, yBase, p1[1] + ez * 0.6 + nz * halfW],
          rgb, route.active ? 0.96 : 0.84
        );
      }
    }
    return new Float32Array(verts);
  }

  // ── Shaders: Derivative-Aware Sharp Pixel-Art Sampling (Zero Shimmer!) ──
  function buildPixelShaders(useDerivatives) {
    const extHeader = useDerivatives ? "#extension GL_OES_standard_derivatives : enable\n" : "";
    const vs = `
      attribute vec3 aPos;
      attribute vec3 aNorm;
      attribute vec2 aUv;
      attribute vec4 aAtlasRect;
      attribute vec4 aMeta;
      uniform mat4 uViewProj;
      varying vec3 vWorldPos;
      varying vec3 vNorm;
      varying vec2 vUv;
      varying vec4 vAtlasRect;
      varying vec4 vMeta;
      void main() {
        vWorldPos = aPos;
        vNorm = aNorm;
        vUv = aUv;
        vAtlasRect = aAtlasRect;
        vMeta = aMeta;
        gl_Position = uViewProj * vec4(aPos, 1.0);
      }
    `;

    const sharpSample = useDerivatives ? `
      vec2 sampleSharpUv(vec2 localUv, vec2 rawUv, vec4 rect, float flags) {
        if (flags > 3.5) {
          return rect.xy + clamp(localUv, vec2(0.008), vec2(0.992)) * rect.zw;
        }
        vec2 atlasPx = rect.zw * 1024.0;
        // Quantize to 2px sub-art-texel grid with screen-space derivative AA (crisp pixels + zero motion shimmer!)
        vec2 texel = localUv * atlasPx;
        vec2 seam = floor(texel + 0.5);
        vec2 fw = max(fwidth(rawUv * atlasPx), vec2(0.001));
        vec2 aa = clamp((texel - seam) / fw, -0.5, 0.5) + 0.5;
        vec2 snapped = (seam - 0.5 + aa) / atlasPx;
        float minify = smoothstep(0.55, 1.25, max(fw.x, fw.y));
        vec2 blended = mix(snapped, localUv, minify);
        return rect.xy + clamp(blended, vec2(0.006), vec2(0.994)) * rect.zw;
      }
    ` : `
      vec2 sampleSharpUv(vec2 localUv, vec2 rawUv, vec4 rect, float flags) {
        return rect.xy + clamp(localUv, vec2(0.006), vec2(0.994)) * rect.zw;
      }
    `;

    const fs = `
      ${extHeader}
      precision mediump float;
      uniform sampler2D uAtlas;
      uniform float uLit[12];
      uniform float uFocusIdx;
      uniform float uFlashIdx;
      uniform float uFlashStrength;
      uniform float uTime;
      varying vec3 vWorldPos;
      varying vec3 vNorm;
      varying vec2 vUv;
      varying vec4 vAtlasRect;
      varying vec4 vMeta;

      ${sharpSample}

      void main() {
        float lidF = vMeta.x;
        int lid = int(lidF + 0.5);
        float ao = vMeta.y;
        float flags = vMeta.z;

        vec2 uv = fract(vUv);
        // Non-repeating sprites (cutout hero facades & trees) clamp cleanly instead of wrapping
        if (flags > 2.5 || (vUv.x >= 0.0 && vUv.x <= 1.0 && vUv.y >= 0.0 && vUv.y <= 1.0)) {
          uv = clamp(vUv, 0.0, 1.0);
        }
        // Gentle Pengjiang River pixel shimmer drift
        if (flags > 0.5 && flags < 1.5) {
          uv = fract(vec2(vUv.x + sin(vWorldPos.z * 0.14 + uTime * 0.8) * 0.025, vUv.y + uTime * 0.012));
        }

        vec2 atlasUv = sampleSharpUv(uv, vUv, vAtlasRect, flags);
        vec4 tex = texture2D(uAtlas, atlasUv);
        if (flags > 2.5 && flags < 3.5 && tex.a < 0.42) discard;

        float litAmt = 0.0;
        for (int idx = 0; idx < 12; idx++) {
          if (idx == lid) litAmt = uLit[idx];
        }
        float isFocus = (uFocusIdx > 0.5 && abs(lidF - uFocusIdx) < 0.25) ? 1.0 : 0.0;
        float isFlash = (uFlashIdx > 0.5 && abs(lidF - uFlashIdx) < 0.25) ? uFlashStrength : 0.0;

        // Preserve original sunlit map.jpg pixel palette while giving gentle 3D directional depth!
        vec3 norm = normalize(vNorm);
        vec3 sunDir = normalize(vec3(-0.32, 0.88, 0.36));
        float ndl = max(dot(norm, sunDir), 0.0);
        float hemi = norm.y * 0.5 + 0.5;
        float shade;
        if (flags > 4.5) {
          float faceShade = (norm.y > 0.5) ? 1.05
            : ((norm.y < -0.5) ? 0.70
            : ((norm.z > 0.5) ? 0.96
            : ((norm.x > 0.5) ? 0.90 : 0.78)));
          shade = faceShade * mix(1.0, ao, 0.55);
        } else if (flags > 0.5 && flags < 2.5) {
          shade = 0.94 + 0.06 * hemi;
        } else {
          shade = (0.80 + 0.12 * hemi + 0.13 * ndl) * mix(1.0, ao, 0.7);
        }

        vec3 col = tex.rgb * shade;

        // Subtle warm vintage paper wash on unlit context, blooming to full crisp vibrancy on lit/focused landmarks
        float luma = dot(col, vec3(0.299, 0.587, 0.114));
        vec3 warmPaper = vec3(luma * 1.03, luma * 0.99, luma * 0.91);
        float satKeep = (lid == 0) ? 0.88 : mix(0.76, 1.06, clamp(max(litAmt, isFocus * 0.95), 0.0, 1.0));
        col = mix(warmPaper, col, satKeep);

        if (isFocus > 0.5) {
          col = col * vec3(1.04, 1.03, 1.00) + vec3(0.015, 0.012, 0.006);
        }
        if (isFlash > 0.01) {
          col = mix(col, vec3(0.92, 0.38, 0.26), isFlash * 0.42);
        }

        gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
      }
    `;
    return { vs, fs };
  }

  const SHADOW_VS = `
    attribute vec3 aPos;
    attribute float aAlpha;
    uniform mat4 uViewProj;
    varying float vAlpha;
    void main() { vAlpha = aAlpha; gl_Position = uViewProj * vec4(aPos, 1.0); }
  `;
  const SHADOW_FS = `
    precision mediump float;
    varying float vAlpha;
    void main() { gl_FragColor = vec4(0.32, 0.25, 0.19, vAlpha); }
  `;
  const ROUTE_VS = `
    attribute vec3 aPos;
    attribute vec3 aColor;
    attribute float aAlpha;
    uniform mat4 uViewProj;
    varying vec3 vColor;
    varying float vAlpha;
    void main() { vColor = aColor; vAlpha = aAlpha; gl_Position = uViewProj * vec4(aPos, 1.0); }
  `;
  const ROUTE_FS = `
    precision mediump float;
    varying vec3 vColor;
    varying float vAlpha;
    void main() { gl_FragColor = vec4(vColor, vAlpha); }
  `;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "Shader compile error");
    }
    return shader;
  }

  function createProgram(gl, vsSrc, fsSrc) {
    const prog = gl.createProgram();
    gl.attachShader(prog, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) || "Program link error");
    }
    return prog;
  }

  // ── Main Pixel-Art 3D Scene Controller ──────────────────────────────────
  class ChangdiPixelScene3D {
    constructor(options) {
      this.canvas = options.canvas;
      this.container = options.container;
      this.onSelectPoint = options.onSelectPoint || (() => {});
      this.onViewChange = options.onViewChange || (() => {});
      this.onZoomSync = options.onZoomSync || (() => {});
      this.onFrameProject = options.onFrameProject || (() => {});
      this.getSheetCoverHeight = options.getSheetCoverHeight || (() => 0);
      this.isReducedMotion = options.isReducedMotion || (() => false);

      this.gl = this.canvas.getContext("webgl", { antialias: true, alpha: false, preserveDrawingBuffer: true })
        || this.canvas.getContext("experimental-webgl", { antialias: true, alpha: false, preserveDrawingBuffer: true });
      if (!this.gl) {
        this.available = false;
        return;
      }
      this.available = true;
      this.hasDerivatives = Boolean(this.gl.getExtension("OES_standard_derivatives"));
      this.anisoExt = this.gl.getExtension("EXT_texture_filter_anisotropic")
        || this.gl.getExtension("MOZ_EXT_texture_filter_anisotropic")
        || this.gl.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
      this.fovRad = 34 * DEG;
      this.zoomLevels = [1.0, 1.5, 2.0];
      this.zoomIndex = 0;
      this.width = 390;
      this.height = 600;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);

      this.viewState = "flat";
      this.viewDirection = "";
      this.focusedPointId = "";
      this.cam = { tx: 0, ty: 0, tz: 0, distance: 255, pitch: 0.005, yaw: 0, ndcOffsetY: 0 };
      this.returnFlatCam = null;
      this.anim = null;
      this.frameCount = 0;
      this.startTime = performance.now();

      this.litTargets = new Float32Array(12);
      this.litCurrent = new Float32Array(12);
      this.flashIdx = -1;
      this.flashUntil = 0;

      this.routes = [];
      this.projMat = mat4.create();
      this.viewMat = mat4.create();
      this.vpMat = mat4.create();
      this.invVpMat = mat4.create();
      this.eyePos = [0, 255, 1];
      this.atlasReady = false;
      this.voxelTier = normalizeVoxelTier(options.voxelTier || readInitialVoxelTier());

      this.world = buildChangdiPixelWorld(this.voxelTier);
      this.initGL();
      this.initAtlas();
      this.initPointerControls();
      this.resize(true);
      this.startLoop();
      this.exposeTelemetry();
    }

    setVoxelTier(nextTier) {
      const tierKey = normalizeVoxelTier(nextTier);
      if (tierKey === this.voxelTier && this.world) return tierKey;
      this.voxelTier = tierKey;
      this.world = buildChangdiPixelWorld(tierKey);
      const gl = this.gl;
      if (gl) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.opaqueBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this.world.opaque, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cutoutBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this.world.cutout, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
        gl.bufferData(gl.ARRAY_BUFFER, this.world.shadows, gl.STATIC_DRAW);
      }
      this.render(performance.now());
      return tierKey;
    }

    measureSampleFeatures() {
      const segs = this.world && this.world.sampleMeasureSegments ? this.world.sampleMeasureSegments : [];
      const dpr = this.dpr || 1;
      return segs.map(seg => {
        const a = this.projectWorld(seg.p0[0], seg.p0[1], seg.p0[2]);
        const b = this.projectWorld(seg.p1[0], seg.p1[1], seg.p1[2]);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const cssPx = Math.hypot(dx, dy);
        return {
          key: seg.key,
          label: seg.label,
          worldUnits: seg.worldSize,
          cssPx: Number(cssPx.toFixed(2)),
          dxCssPx: Number(Math.abs(dx).toFixed(2)),
          dyCssPx: Number(Math.abs(dy).toFixed(2)),
          canvasPx: Number((cssPx * dpr).toFixed(2)),
          note: seg.note
        };
      });
    }

    initGL() {
      const gl = this.gl;
      const { vs, fs } = buildPixelShaders(this.hasDerivatives);
      this.pixelProg = createProgram(gl, vs, fs);
      this.shadowProg = createProgram(gl, SHADOW_VS, SHADOW_FS);
      this.routeProg = createProgram(gl, ROUTE_VS, ROUTE_FS);

      this.opaqueBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.opaqueBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.world.opaque, gl.STATIC_DRAW);

      this.cutoutBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cutoutBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.world.cutout, gl.STATIC_DRAW);

      this.shadowBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.world.shadows, gl.STATIC_DRAW);

      this.routeBuf = gl.createBuffer();
      this.atlasTex = gl.createTexture();

      this.pixelLoc = {
        aPos: gl.getAttribLocation(this.pixelProg, "aPos"),
        aNorm: gl.getAttribLocation(this.pixelProg, "aNorm"),
        aUv: gl.getAttribLocation(this.pixelProg, "aUv"),
        aAtlasRect: gl.getAttribLocation(this.pixelProg, "aAtlasRect"),
        aMeta: gl.getAttribLocation(this.pixelProg, "aMeta"),
        uViewProj: gl.getUniformLocation(this.pixelProg, "uViewProj"),
        uAtlas: gl.getUniformLocation(this.pixelProg, "uAtlas"),
        uLit: gl.getUniformLocation(this.pixelProg, "uLit"),
        uFocusIdx: gl.getUniformLocation(this.pixelProg, "uFocusIdx"),
        uFlashIdx: gl.getUniformLocation(this.pixelProg, "uFlashIdx"),
        uFlashStrength: gl.getUniformLocation(this.pixelProg, "uFlashStrength"),
        uTime: gl.getUniformLocation(this.pixelProg, "uTime")
      };
      this.shadowLoc = {
        aPos: gl.getAttribLocation(this.shadowProg, "aPos"),
        aAlpha: gl.getAttribLocation(this.shadowProg, "aAlpha"),
        uViewProj: gl.getUniformLocation(this.shadowProg, "uViewProj")
      };
      this.routeLoc = {
        aPos: gl.getAttribLocation(this.routeProg, "aPos"),
        aColor: gl.getAttribLocation(this.routeProg, "aColor"),
        aAlpha: gl.getAttribLocation(this.routeProg, "aAlpha"),
        uViewProj: gl.getUniformLocation(this.routeProg, "uViewProj")
      };
    }

    uploadAtlas(canvas) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      // Use linear filtering + derivative-aware shader AA (sharp pixels + zero moire shimmer!)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (this.anisoExt) {
        const maxAniso = gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 4;
        gl.texParameterf(gl.TEXTURE_2D, this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxAniso));
      }
    }

    initAtlas() {
      this.atlas = window.ChangdiPixelAtlas.createPixelAtlas((canvas, st) => {
        this.uploadAtlas(canvas);
        this.atlasReady = st.loadedIso && st.loadedTop;
      });
      this.uploadAtlas(this.atlas.canvas);
    }

    computeFlatDistance(zoomScale = this.zoomLevels[this.zoomIndex]) {
      const aspect = Math.max(0.35, this.width / Math.max(1, this.height));
      const tanHalf = Math.tan(this.fovRad / 2);
      const distForWidth = 100 / (aspect * 2 * tanHalf);
      const distForHeight = 148 / (2 * tanHalf);
      return Math.max(distForWidth, distForHeight) / zoomScale;
    }

    computeFocusNdcOffsetY(overrideCover = null) {
      const cover = overrideCover !== null ? overrideCover : this.getSheetCoverHeight();
      if (cover <= 0 || this.height <= 1) return 0;
      const visibleH = Math.max(130, this.height - cover);
      const visibleCenterY = visibleH / 2;
      return 1 - 2 * (visibleCenterY / this.height);
    }

    computeFocusDistance(spec, zoomScale = this.zoomLevels[this.zoomIndex], overrideCover = null) {
      const base = spec ? spec.dist : 84;
      const cover = overrideCover !== null ? overrideCover : this.getSheetCoverHeight();
      const visibleH = Math.max(150, this.height - cover);
      const refH = (spec && spec.compactRefH) ? spec.compactRefH : 250;
      const maxBoost = (spec && spec.maxCompactBoost) ? spec.maxCompactBoost : 1.26;
      const compactBoost = visibleH < refH ? clamp(refH / visibleH, 1.0, maxBoost) : 1.0;
      return (base * compactBoost) / zoomScale;
    }

    projectSampleShops() {
      const boxes = this.world && this.world.sampleShopBoxes ? this.world.sampleShopBoxes : [];
      return boxes.map(box => {
        const [x0, y0, z0] = box.min;
        const [x1, y1, z1] = box.max;
        const corners = [
          [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1],
          [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]
        ];
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [wx, wy, wz] of corners) {
          const pt = this.projectWorld(wx, wy, wz);
          if (pt.x < minX) minX = pt.x;
          if (pt.y < minY) minY = pt.y;
          if (pt.x > maxX) maxX = pt.x;
          if (pt.y > maxY) maxY = pt.y;
        }
        return {
          id: box.id,
          name: box.name,
          left: Number(minX.toFixed(1)),
          top: Number(minY.toFixed(1)),
          right: Number(maxX.toFixed(1)),
          bottom: Number(maxY.toFixed(1)),
          width: Number((maxX - minX).toFixed(1)),
          height: Number((maxY - minY).toFixed(1))
        };
      });
    }

    getFlatPanBounds(distance = this.cam.distance) {
      const aspect = Math.max(0.35, this.width / Math.max(1, this.height));
      const visibleH = 2 * distance * Math.tan(this.fovRad / 2);
      const visibleW = visibleH * aspect;
      return {
        maxX: Math.max(0, (100 - visibleW) / 2 + 4),
        maxZ: Math.max(0, (150 - visibleH) / 2 + 4)
      };
    }

    clampFlatTarget(tx, tz, distance = this.cam.distance) {
      const { maxX, maxZ } = this.getFlatPanBounds(distance);
      return [clamp(tx, -maxX, maxX), clamp(tz, -maxZ, maxZ)];
    }

    // Defect 2 root-cause fix: ALWAYS keep flat distance synced even during a flat pan glide!
    resize(initial = false) {
      if (!this.available) return;
      const rect = this.container.getBoundingClientRect();
      const nextW = Math.max(200, Math.round(rect.width));
      const nextH = Math.max(200, Math.round(rect.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.width = nextW;
      this.height = nextH;
      this.canvas.width = Math.round(nextW * this.dpr);
      this.canvas.height = Math.round(nextH * this.dpr);
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);

      if (this.viewState === "flat") {
        const nextDist = this.computeFlatDistance();
        if (initial || !this.anim) {
          this.cam.distance = nextDist;
          const [cx, cz] = this.clampFlatTarget(this.cam.tx, this.cam.tz, nextDist);
          this.cam.tx = cx;
          this.cam.tz = cz;
        } else if (this.anim.kind === "glide") {
          this.anim.to.distance = nextDist;
          const [cx, cz] = this.clampFlatTarget(this.anim.to.tx, this.anim.to.tz, nextDist);
          this.anim.to.tx = cx;
          this.anim.to.tz = cz;
        }
      } else if (!this.anim && this.viewState === "focused") {
        this.cam.ndcOffsetY = this.computeFocusNdcOffsetY();
      }
      this.updateCameraMatrices();
    }

    setLitIds(litSet) {
      this.litTargets.fill(0);
      for (const spec of LANDMARK_SPECS) {
        if (litSet.has(spec.id)) this.litTargets[spec.idx] = 1;
      }
      if (this.isReducedMotion()) this.litCurrent.set(this.litTargets);
    }

    flashPoint(pointId) {
      const spec = LANDMARK_BY_ID.get(pointId);
      if (!spec) return;
      this.flashIdx = spec.idx;
      this.flashUntil = performance.now() + 1800;
    }

    setRoutes(routeList) {
      const now = performance.now();
      const reduced = this.isReducedMotion();
      this.routes = routeList.map(route => ({
        color: route.color,
        active: Boolean(route.active),
        worldPoints: route.uvPoints.map(([u, v]) => toWorld(u, v)),
        startMs: now,
        durationMs: (route.animate && !reduced) ? 1000 : 0
      }));
    }

    panToPointFlat(pointId, smooth = true) {
      const spec = LANDMARK_BY_ID.get(pointId);
      if (!spec || this.viewState !== "flat") return;
      const flatDist = this.computeFlatDistance();
      const [targetX, targetZ] = this.clampFlatTarget(spec.focus[0], spec.focus[2], flatDist);
      if (!smooth || this.isReducedMotion()) {
        this.cam.tx = targetX;
        this.cam.tz = targetZ;
        this.cam.distance = flatDist;
        this.anim = null;
        this.updateCameraMatrices();
        return;
      }
      this.anim = {
        kind: "glide",
        startMs: performance.now(),
        durationMs: 380,
        from: { ...this.cam },
        to: { ...this.cam, tx: targetX, tz: targetZ, distance: flatDist }
      };
    }

    setZoomIndex(nextIndex, { animate = true } = {}) {
      const clamped = clamp(nextIndex, 0, this.zoomLevels.length - 1);
      if (clamped === this.zoomIndex) return this.zoomIndex;
      this.zoomIndex = clamped;
      const zoomScale = this.zoomLevels[this.zoomIndex];
      let nextDist;
      if (this.viewState === "flat") {
        nextDist = this.computeFlatDistance(zoomScale);
      } else {
        const spec = LANDMARK_BY_ID.get(this.focusedPointId);
        nextDist = this.computeFocusDistance(spec, zoomScale);
      }
      const nextOffsetY = this.viewState === "focused" ? this.computeFocusNdcOffsetY() : 0;
      const [targetTx, targetTz] = this.viewState === "flat"
        ? (this.zoomIndex === 0 ? [0, 0] : this.clampFlatTarget(this.cam.tx, this.cam.tz, nextDist))
        : [this.cam.tx, this.cam.tz];

      if (!animate || this.isReducedMotion()) {
        this.anim = null;
        this.cam.tx = targetTx;
        this.cam.tz = targetTz;
        this.cam.distance = nextDist;
        this.cam.ndcOffsetY = nextOffsetY;
        this.updateCameraMatrices();
      } else {
        this.anim = {
          kind: "glide",
          startMs: performance.now(),
          durationMs: 420,
          from: { ...this.cam },
          to: { ...this.cam, tx: targetTx, tz: targetTz, distance: nextDist, ndcOffsetY: nextOffsetY }
        };
      }
      return this.zoomIndex;
    }

    refreshSheetAlignment() {
      if (this.viewState !== "focused") return;
      const desired = this.computeFocusNdcOffsetY();
      const spec = LANDMARK_BY_ID.get(this.focusedPointId);
      const desiredDist = this.computeFocusDistance(spec);
      if (this.anim && this.anim.kind === "focus-choreo") {
        this.anim.end.ndcOffsetY = desired;
        this.anim.end.distance = desiredDist;
      } else if (this.anim && this.anim.kind === "glide") {
        this.anim.to.ndcOffsetY = desired;
        this.anim.to.distance = desiredDist;
      } else {
        this.cam.ndcOffsetY = desired;
        this.updateCameraMatrices();
      }
    }

    // Defect 1 + Defect 2 Root-Cause Fix:
    // - Captures exact pre-focus flat snapshot (tx, ty, tz, distance, zoomIndex)
    // - Runs ONE continuous unbroken choreographed curve (tilt 0->45 + pre-lift target above sheet + push-in)
    //   so sheet NEVER covers hero buildings (Didong Qilou / Shuibutou / Iron Bridge) mid-push!
    focusPoint(pointId, { onPrepareSheet, onRevealSheet } = {}) {
      const spec = LANDMARK_BY_ID.get(pointId);
      if (!spec) return;
      const wasFlat = this.viewState === "flat";
      if (wasFlat) {
        // If a flat pan glide was still finishing, settle its target cleanly into the snapshot
        const snapTx = this.anim?.kind === "glide" ? this.anim.to.tx : this.cam.tx;
        const snapTz = this.anim?.kind === "glide" ? this.anim.to.tz : this.cam.tz;
        const snapDist = this.anim?.kind === "glide" ? this.anim.to.distance : this.cam.distance;
        this.returnFlatCam = {
          tx: snapTx,
          ty: 0,
          tz: snapTz,
          distance: snapDist,
          zoomIndex: this.zoomIndex
        };
      }
      this.focusedPointId = pointId;
      const zoomScale = this.zoomLevels[this.zoomIndex];

      // Pre-mount & measure exact sheet height off-screen before animating so camera lifts target accurately!
      const predictedCover = onPrepareSheet ? onPrepareSheet() : this.getSheetCoverHeight();
      const targetOffsetY = this.computeFocusNdcOffsetY(predictedCover);
      const targetDist = this.computeFocusDistance(spec, zoomScale, predictedCover);

      const endCam = {
        tx: spec.focus[0],
        ty: spec.focus[1],
        tz: spec.focus[2],
        distance: targetDist,
        pitch: spec.pitch * DEG,
        yaw: spec.yaw * DEG,
        ndcOffsetY: targetOffsetY
      };

      if (this.isReducedMotion()) {
        this.anim = null;
        this.viewState = "focused";
        this.viewDirection = "in";
        this.onViewChange("focused", "in", pointId);
        if (onRevealSheet) onRevealSheet(true);
        endCam.ndcOffsetY = this.computeFocusNdcOffsetY();
        endCam.distance = this.computeFocusDistance(spec, zoomScale);
        this.cam = { ...endCam };
        this.updateCameraMatrices();
        return;
      }

      if (!wasFlat) {
        this.viewState = "focused";
        this.viewDirection = "in";
        this.onViewChange("focused", "in", pointId);
        if (onRevealSheet) onRevealSheet(false);
        this.anim = {
          kind: "glide",
          startMs: performance.now(),
          durationMs: 680,
          from: { ...this.cam },
          to: endCam
        };
        return;
      }

      this.viewState = "tilted";
      this.viewDirection = "in";
      this.onViewChange("tilted", "in", pointId);

      this.anim = {
        kind: "focus-choreo",
        startMs: performance.now(),
        totalMs: 1460,
        start: { ...this.cam },
        end: endCam,
        revealedSheet: false,
        onRevealSheet
      };
    }

    // Defect 1 + Defect 2 Root-Cause Fix:
    // - Coordinates sheet slide-down with camera pull-back & level-up (zero sudden card disappearance!)
    // - Restores EXACT pre-focus flat snapshot (tx, tz, distance, AND zoomIndex!)
    returnToFlat({ immediate = false, onFinish } = {}) {
      const saved = this.returnFlatCam || {
        tx: 0, ty: 0, tz: 0, distance: this.computeFlatDistance(1), zoomIndex: 0
      };
      // Always restore original pre-focus zoom level too (fixes returning after 150%/200% zoom in card!)
      if (this.zoomIndex !== saved.zoomIndex) {
        this.zoomIndex = saved.zoomIndex;
        this.onZoomSync(saved.zoomIndex);
      }
      const flatCam = {
        tx: saved.tx,
        ty: 0,
        tz: saved.tz,
        distance: saved.distance,
        pitch: 0.005,
        yaw: 0,
        ndcOffsetY: 0
      };

      if (immediate || this.isReducedMotion() || this.viewState === "flat") {
        this.anim = null;
        this.focusedPointId = "";
        this.returnFlatCam = null;
        this.viewState = "flat";
        this.viewDirection = "";
        this.cam = { ...flatCam };
        this.onViewChange("flat", "", "");
        this.updateCameraMatrices();
        if (onFinish) onFinish();
        return;
      }

      this.viewState = "tilted";
      this.viewDirection = "out";
      this.onViewChange("tilted", "out", this.focusedPointId);

      this.anim = {
        kind: "return-flat",
        startMs: performance.now(),
        durationMs: 1080,
        from: { ...this.cam },
        to: flatCam,
        onFinish
      };
    }

    stepAnimation(now) {
      for (let idx = 0; idx < 12; idx += 1) {
        const diff = this.litTargets[idx] - this.litCurrent[idx];
        if (Math.abs(diff) > 0.002) {
          this.litCurrent[idx] += diff * (this.isReducedMotion() ? 1 : 0.1);
        } else {
          this.litCurrent[idx] = this.litTargets[idx];
        }
      }

      if (!this.anim) return;
      const anim = this.anim;
      const elapsed = now - anim.startMs;

      if (anim.kind === "glide") {
        const ratio = clamp(elapsed / anim.durationMs, 0, 1);
        const eased = easeInOutCubic(ratio);
        for (const key of ["tx", "ty", "tz", "distance", "pitch", "yaw", "ndcOffsetY"]) {
          this.cam[key] = lerp(anim.from[key], anim.to[key], eased);
        }
        if (ratio >= 1) this.anim = null;
      } else if (anim.kind === "focus-choreo") {
        const t = clamp(elapsed / anim.totalMs, 0, 1);
        // Stage 1 tilt leads smoothly (0..56%), target & pre-lift smoothly sweep (8%..84%), push-in accelerates smoothly (28%..100%)
        const tiltR = easeInOutCubic(clamp(t / 0.56, 0, 1));
        const yawR = easeInOutCubic(clamp(t / 0.64, 0, 1));
        const targetR = easeInOutCubic(clamp((t - 0.06) / 0.80, 0, 1));
        const liftR = easeOutCubic(clamp((t - 0.18) / 0.60, 0, 1));
        const pushR = easeInOutCubic(clamp((t - 0.28) / 0.72, 0, 1));

        this.cam.pitch = lerp(anim.start.pitch, anim.end.pitch, tiltR);
        this.cam.yaw = lerp(anim.start.yaw, anim.end.yaw, yawR);
        this.cam.tx = lerp(anim.start.tx, anim.end.tx, targetR);
        this.cam.ty = lerp(anim.start.ty, anim.end.ty, targetR);
        this.cam.tz = lerp(anim.start.tz, anim.end.tz, targetR);
        this.cam.ndcOffsetY = lerp(anim.start.ndcOffsetY, anim.end.ndcOffsetY, liftR);
        this.cam.distance = lerp(anim.start.distance, anim.end.distance, pushR);

        // Reveal sliding paper card at t=0.52 AFTER landmark is already lifted into upper viewport!
        if (!anim.revealedSheet && t >= 0.52) {
          anim.revealedSheet = true;
          this.viewState = "focused";
          this.viewDirection = "in";
          this.onViewChange("focused", "in", this.focusedPointId);
          if (anim.onRevealSheet) anim.onRevealSheet(false);
        }
        if (t >= 1) this.anim = null;
      } else if (anim.kind === "return-flat") {
        const t = clamp(elapsed / anim.durationMs, 0, 1);
        // Sheet slides down over t=0..0.34 in sync with ndcOffsetY returning smoothly to 0!
        const unliftR = easeInOutCubic(clamp(t / 0.42, 0, 1));
        const pullR = easeInOutCubic(clamp(t / 0.68, 0, 1));
        const levelR = easeInOutCubic(clamp((t - 0.14) / 0.86, 0, 1));
        this.cam.ndcOffsetY = lerp(anim.from.ndcOffsetY, 0, unliftR);
        this.cam.tx = lerp(anim.from.tx, anim.to.tx, pullR);
        this.cam.ty = lerp(anim.from.ty, anim.to.ty, pullR);
        this.cam.tz = lerp(anim.from.tz, anim.to.tz, pullR);
        this.cam.distance = lerp(anim.from.distance, anim.to.distance, pullR);
        this.cam.pitch = lerp(anim.from.pitch, anim.to.pitch, levelR);
        this.cam.yaw = lerp(anim.from.yaw, anim.to.yaw, levelR);
        if (t >= 1) {
          const cb = anim.onFinish;
          this.anim = null;
          this.focusedPointId = "";
          this.returnFlatCam = null;
          this.viewState = "flat";
          this.viewDirection = "";
          this.onViewChange("flat", "", "");
          if (cb) cb();
        }
      }
    }

    updateCameraMatrices() {
      const { tx, ty, tz, distance, pitch, yaw, ndcOffsetY } = this.cam;
      const sinP = Math.sin(pitch);
      const cosP = Math.cos(pitch);
      const ex = tx + distance * sinP * Math.sin(yaw);
      const ey = ty + distance * cosP;
      const ez = tz + distance * sinP * Math.cos(yaw);
      this.eyePos = [ex, ey, ez];

      const aspect = Math.max(0.3, this.width / Math.max(1, this.height));
      mat4.perspective(this.projMat, this.fovRad, aspect, 1.0, 900.0, ndcOffsetY);
      mat4.lookAt(this.viewMat, this.eyePos, [tx, ty, tz], [0, 1, 0]);
      mat4.multiply(this.vpMat, this.projMat, this.viewMat);
      mat4.invert(this.invVpMat, this.vpMat);
    }

    projectWorld(wx, wy, wz) {
      return projectPoint(this.vpMat, wx, wy, wz, this.width, this.height);
    }

    projectUv(u, v, y = 0.4) {
      const [wx, wz] = toWorld(u, v);
      return this.projectWorld(wx, y, wz);
    }

    pickAtClient(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const sx = clientX - rect.left;
      const sy = clientY - rect.top;
      const ndcX = (sx / rect.width) * 2 - 1;
      const ndcY = 1 - (sy / rect.height) * 2;

      const unproject = ndcZ => {
        const m = this.invVpMat;
        const x = m[0] * ndcX + m[4] * ndcY + m[8] * ndcZ + m[12];
        const y = m[1] * ndcX + m[5] * ndcY + m[9] * ndcZ + m[13];
        const z = m[2] * ndcX + m[6] * ndcY + m[10] * ndcZ + m[14];
        const w = m[3] * ndcX + m[7] * ndcY + m[11] * ndcZ + m[15];
        return [x / w, y / w, z / w];
      };

      const nearPt = unproject(-1);
      const farPt = unproject(1);
      const dx = farPt[0] - nearPt[0];
      const dy = farPt[1] - nearPt[1];
      const dz = farPt[2] - nearPt[2];
      const len = Math.hypot(dx, dy, dz) || 1;
      const dir = [dx / len, dy / len, dz / len];

      let bestId = "";
      let bestT = Infinity;
      for (const box of this.world.pickBoxes) {
        const hitT = rayIntersectsBox(nearPt, dir, box);
        if (hitT !== null && hitT < bestT) {
          bestT = hitT;
          bestId = box.id;
        }
      }
      return bestId;
    }

    initPointerControls() {
      let pointerDown = null;
      let moved = false;
      const activePointers = new Map();
      let pinchStartDist = 0;

      this.canvas.addEventListener("pointerdown", event => {
        if (event.button !== 0 && event.pointerType === "mouse") return;
        activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        this.canvas.setPointerCapture?.(event.pointerId);
        if (activePointers.size === 2) {
          const [a, b] = [...activePointers.values()];
          pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
          pointerDown = null;
          return;
        }
        pointerDown = {
          id: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          lastX: event.clientX,
          lastY: event.clientY
        };
        moved = false;
      });

      this.canvas.addEventListener("pointermove", event => {
        if (activePointers.has(event.pointerId)) {
          activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }
        if (activePointers.size === 2 && pinchStartDist > 10) {
          const [a, b] = [...activePointers.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist > pinchStartDist * 1.24) {
            this.onPinchZoom?.(1);
            pinchStartDist = dist;
          } else if (dist < pinchStartDist * 0.78) {
            this.onPinchZoom?.(-1);
            pinchStartDist = dist;
          }
          return;
        }
        if (!pointerDown || pointerDown.id !== event.pointerId) return;
        const dx = event.clientX - pointerDown.lastX;
        const dy = event.clientY - pointerDown.lastY;
        if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 6) moved = true;
        if (!moved) return;

        pointerDown.lastX = event.clientX;
        pointerDown.lastY = event.clientY;
        this.anim = null;

        if (this.viewState === "flat") {
          const worldPerPx = (2 * this.cam.distance * Math.tan(this.fovRad / 2)) / Math.max(1, this.height);
          const [nx, nz] = this.clampFlatTarget(this.cam.tx - dx * worldPerPx, this.cam.tz - dy * worldPerPx);
          this.cam.tx = nx;
          this.cam.tz = nz;
        } else {
          this.cam.yaw = clamp(this.cam.yaw - dx * 0.0055, -24 * DEG, 52 * DEG);
          this.cam.pitch = clamp(this.cam.pitch - dy * 0.0045, 28 * DEG, 58 * DEG);
        }
      });

      const endPointer = event => {
        activePointers.delete(event.pointerId);
        if (!pointerDown || pointerDown.id !== event.pointerId) return;
        const wasClick = !moved;
        pointerDown = null;
        if (wasClick) {
          const hitId = this.pickAtClient(event.clientX, event.clientY);
          if (hitId) this.onSelectPoint(hitId, this.canvas);
        }
      };

      this.canvas.addEventListener("pointerup", endPointer);
      this.canvas.addEventListener("pointercancel", endPointer);
      this.canvas.addEventListener("wheel", event => {
        event.preventDefault();
        if (Math.abs(event.deltaY) < 8) return;
        this.onPinchZoom?.(event.deltaY < 0 ? 1 : -1);
      }, { passive: false });
    }

    bindPixelBuffer(buf) {
      const gl = this.gl;
      const stride = 16 * 4;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.enableVertexAttribArray(this.pixelLoc.aPos);
      gl.vertexAttribPointer(this.pixelLoc.aPos, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.pixelLoc.aNorm);
      gl.vertexAttribPointer(this.pixelLoc.aNorm, 3, gl.FLOAT, false, stride, 12);
      gl.enableVertexAttribArray(this.pixelLoc.aUv);
      gl.vertexAttribPointer(this.pixelLoc.aUv, 2, gl.FLOAT, false, stride, 24);
      gl.enableVertexAttribArray(this.pixelLoc.aAtlasRect);
      gl.vertexAttribPointer(this.pixelLoc.aAtlasRect, 4, gl.FLOAT, false, stride, 32);
      gl.enableVertexAttribArray(this.pixelLoc.aMeta);
      gl.vertexAttribPointer(this.pixelLoc.aMeta, 4, gl.FLOAT, false, stride, 48);
    }

    render(now) {
      const gl = this.gl;
      this.stepAnimation(now);
      this.updateCameraMatrices();

      gl.clearColor(0.935, 0.902, 0.824, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);

      const focusSpec = LANDMARK_BY_ID.get(this.focusedPointId);
      const focusIdx = focusSpec ? focusSpec.idx : -1;
      const flashRemaining = this.flashUntil - now;
      const flashStrength = flashRemaining > 0 ? (Math.sin(flashRemaining * 0.015) * 0.5 + 0.5) : 0;
      const animTime = this.isReducedMotion() ? 0 : (now - this.startTime) * 0.001;

      // 1. Opaque pixel-art 3D buildings, ground, river, roofs
      gl.disable(gl.BLEND);
      gl.useProgram(this.pixelProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
      gl.uniform1i(this.pixelLoc.uAtlas, 0);
      gl.uniformMatrix4fv(this.pixelLoc.uViewProj, false, this.vpMat);
      gl.uniform1fv(this.pixelLoc.uLit, this.litCurrent);
      gl.uniform1f(this.pixelLoc.uFocusIdx, focusIdx);
      gl.uniform1f(this.pixelLoc.uFlashIdx, flashRemaining > 0 ? this.flashIdx : -1);
      gl.uniform1f(this.pixelLoc.uFlashStrength, flashStrength);
      gl.uniform1f(this.pixelLoc.uTime, animTime);

      this.bindPixelBuffer(this.opaqueBuf);
      gl.drawArrays(gl.TRIANGLES, 0, this.world.opaqueCount);

      // 2. Soft sunlit ground shadows
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.useProgram(this.shadowProg);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.shadowBuf);
      gl.enableVertexAttribArray(this.shadowLoc.aPos);
      gl.vertexAttribPointer(this.shadowLoc.aPos, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(this.shadowLoc.aAlpha);
      gl.vertexAttribPointer(this.shadowLoc.aAlpha, 1, gl.FLOAT, false, 16, 12);
      gl.uniformMatrix4fv(this.shadowLoc.uViewProj, false, this.vpMat);
      gl.drawArrays(gl.TRIANGLES, 0, this.world.shadowCount);

      // 3. 3D street-hugging route ribbons
      if (this.routes.length > 0) {
        const routeData = buildRouteMesh(this.routes, now);
        if (routeData.length > 0) {
          gl.useProgram(this.routeProg);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.routeBuf);
          gl.bufferData(gl.ARRAY_BUFFER, routeData, gl.DYNAMIC_DRAW);
          gl.enableVertexAttribArray(this.routeLoc.aPos);
          gl.vertexAttribPointer(this.routeLoc.aPos, 3, gl.FLOAT, false, 28, 0);
          gl.enableVertexAttribArray(this.routeLoc.aColor);
          gl.vertexAttribPointer(this.routeLoc.aColor, 3, gl.FLOAT, false, 28, 12);
          gl.enableVertexAttribArray(this.routeLoc.aAlpha);
          gl.vertexAttribPointer(this.routeLoc.aAlpha, 1, gl.FLOAT, false, 28, 24);
          gl.uniformMatrix4fv(this.routeLoc.uViewProj, false, this.vpMat);
          gl.drawArrays(gl.TRIANGLES, 0, routeData.length / 7);
        }
      }

      // 4. Alpha-cutout 3D elements (scalloped qilou gables, bridges, trees, pedestrians) with real depth write!
      gl.disable(gl.BLEND);
      gl.depthMask(true);
      gl.useProgram(this.pixelProg);
      this.bindPixelBuffer(this.cutoutBuf);
      gl.drawArrays(gl.TRIANGLES, 0, this.world.cutoutCount);

      const projected = {};
      for (const spec of LANDMARK_SPECS) {
        projected[spec.id] = {
          labelPos: this.projectWorld(spec.label[0], spec.label[1], spec.label[2]),
          focusPos: this.projectWorld(spec.focus[0], spec.focus[1], spec.focus[2])
        };
      }
      projected.__sampleShops = this.projectSampleShops();
      projected.__pitchDeg = this.cam.pitch / DEG;
      this.onFrameProject(projected);
      this.frameCount += 1;
    }

    startLoop() {
      const tick = now => {
        this.render(now);
        this.rafId = requestAnimationFrame(tick);
      };
      this.rafId = requestAnimationFrame(tick);
    }

    exposeTelemetry() {
      window.__CD3D__ = {
        isWebGL: true,
        style: "pixel-3d-v2",
        getState: () => {
          const landmarks = {};
          for (const spec of LANDMARK_SPECS) {
            landmarks[spec.id] = {
              baseScreen: this.projectWorld(spec.base[0], spec.base[1], spec.base[2]),
              roofScreen: this.projectWorld(spec.roof[0], spec.roof[1], spec.roof[2]),
              focusScreen: this.projectWorld(spec.focus[0], spec.focus[1], spec.focus[2]),
              labelScreen: this.projectWorld(spec.label[0], spec.label[1], spec.label[2])
            };
          }
          return {
            view: this.viewState,
            direction: this.viewDirection,
            focusedPointId: this.focusedPointId,
            atlasReady: this.atlasReady,
            pitchDeg: Number((this.cam.pitch / DEG).toFixed(2)),
            yawDeg: Number((this.cam.yaw / DEG).toFixed(2)),
            distance: Number(this.cam.distance.toFixed(2)),
            target: [Number(this.cam.tx.toFixed(2)), Number(this.cam.ty.toFixed(2)), Number(this.cam.tz.toFixed(2))],
            eye: this.eyePos.map(val => Number(val.toFixed(2))),
            ndcOffsetY: Number(this.cam.ndcOffsetY.toFixed(4)),
            zoomPercent: Math.round(this.zoomLevels[this.zoomIndex] * 100),
            animating: Boolean(this.anim),
            frameCount: this.frameCount,
            width: this.width,
            height: this.height,
            dpr: this.dpr,
            voxelTier: this.voxelTier,
            voxelUnit: this.world ? this.world.voxelUnit : 0.48,
            landmarks,
            sampleShops: this.projectSampleShops()
          };
        },
        setVoxelTier: tier => this.setVoxelTier(tier),
        measureSampleFeatures: () => this.measureSampleFeatures(),
        projectUv: (u, v, y = 0.34) => this.projectUv(u, v, y),
        projectWorld: (wx, wy, wz) => this.projectWorld(wx, wy, wz)
      };
    }
  }

  window.ChangdiScene3D = ChangdiPixelScene3D;
  window.CD_LANDMARK_SPECS = LANDMARK_SPECS;
})();
