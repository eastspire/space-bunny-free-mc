// First-person player: pointer-lock look, AABB voxel collision, voxel raycast.

import * as THREE from '../vendor/three.module.js';
import { AIR, WATER, isSolid, isLiquid, blocks } from './blocks.js';
import { CHUNK_Y, SEA_LEVEL } from './world.js';

const WIDTH = 0.6, HEIGHT = 1.8, EYE = 1.62;
const GRAVITY = 30, JUMP_V = 8.6, TERMINAL = 55;

export class Player {
  constructor(world, camera) {
    this.world = world;
    this.camera = camera;
    this.pos = new THREE.Vector3(0.5, 40, 0.5);
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = false;
    this.flying = false;
    this.sprinting = false;
    this.inWater = false;
    this.keys = new Set();
    this.reach = 5.5;
    this.bob = 0;
  }

  get eyeY() { return this.pos.y + EYE; }

  /**
   * Drop the player onto a dry, unobstructed patch of ground near (x, z).
   * Uses heightAt (not surfaceY) so it works before any chunk is generated.
   * A column is rejected when it is underwater, sits under a tree canopy, or
   * has terrain/trees hemming it in on every side — the opening frame should
   * look out over the world, not into a trunk. Also returns the yaw that has
   * the longest clear line of sight, so the default view is the scenic one.
   */
  spawnAt(x, z) {
    const w = this.world;
    const bx = Math.floor(x), bz = Math.floor(z);
    let fallback = null, best = null;
    for (let r = 0; r < 24; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = bx + dx, cz = bz + dz;
          const h = Math.floor(w.heightAt(cx, cz));
          if (h < 1 || h >= CHUNK_Y - 4) continue;
          if (h <= SEA_LEVEL) continue;   // no spawning in the sea

          // headroom: the column itself plus its 8 neighbours must be free of
          // canopy, otherwise the opening shot is a wall of leaves.
          let open = 0;
          for (let nz = -1; nz <= 1; nz++) {
            for (let nx = -1; nx <= 1; nx++) {
              if (w.treeAt(cx + nx, cz + nz)) { open = 0; break; }
              if (Math.floor(w.heightAt(cx + nx, cz + nz)) <= h + 2) open++;
            }
            if (!open) break;
          }
          if (!fallback || fallback.open < open) fallback = { x: cx, z: cz, y: h, open };

          // Score a clearing: a wider ring of tree-free, low ground plus a
          // long sightline means the opening frame looks out over the world
          // instead of into a trunk two blocks away.
          let clearing = 0;
          for (let nz = -3; nz <= 3; nz++) {
            for (let nx = -3; nx <= 3; nx++) {
              if (w.treeAt(cx + nx, cz + nz)) continue;
              if (Math.floor(w.heightAt(cx + nx, cz + nz)) <= h + 2) clearing++;
            }
          }
          const score = open * 1000 + clearing * 10 - Math.hypot(dx, dz);
          if (!best || score > best.score) {
            best = { x: cx, z: cz, y: h, open, clearing, score, r };
          }
        }
      }
      // A fully open column with a generous clearing near the requested point
      // is good enough; stop widening the search.
      if (best && best.open === 9 && best.clearing >= 44) break;
    }
    const f = best || fallback
      || { x: bx, z: bz, y: Math.max(Math.floor(w.heightAt(bx, bz)) - 1, 1) };
    this.pos.set(f.x + 0.5, f.y + 1.05, f.z + 0.5);
    this.vel.set(0, 0, 0);
    this.yaw = this.openYaw(f.x, f.y, f.z);
    return best ? f : null;
  }

  /**
   * Yaw (radians) facing the most open direction from a column.
   *
   * Scores each of 16 compass octants by "horizon openness": the highest
   * elevation angle reached by terrain (or a tree canopy) anywhere along the
   * sightline, up to 40 blocks out. The octant with the *lowest* such angle is
   * the one where the land falls away and the sky and distance open up, which
   * is what makes a good opening shot. A plain "nothing directly in front"
   * test is not enough — a gentle uphill counts as clear but fills the frame.
   */
  openYaw(cx, h, cz, reach = 40) {
    let bestYaw = 0, bestScore = Infinity;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const dx = Math.round(Math.cos(ang)), dz = Math.round(Math.sin(ang));
      let worst = -Infinity;
      for (let s = 2; s <= reach; s += 2) {
        const tx = cx + dx * s, tz = cz + dz * s;
        let top = this.world.heightAt(tx, tz);
        const tree = this.world.treeAt(tx, tz);
        if (tree) top += 4 + tree.trunk;          // canopy blocks the view too
        worst = Math.max(worst, top - h);
      }
      if (worst < bestScore) { bestScore = worst; bestYaw = ang; }
    }
    // yaw is measured so that -Z is 0; convert the world octant to that basis
    return Math.atan2(-Math.cos(bestYaw), -Math.sin(bestYaw));
  }

  look(dx, dy, sensitivity = 0.0022) {
    this.yaw -= dx * sensitivity;
    this.pitch -= dy * sensitivity;
    const lim = Math.PI / 2 - 0.001;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  /** Move one axis, then resolve penetration against the voxel grid. */
  moveAxis(axis, amount) {
    if (amount === 0) return false;
    const p = this.pos;
    p[axis] += amount;
    const minX = Math.floor(p.x - WIDTH / 2), maxX = Math.floor(p.x + WIDTH / 2);
    const minY = Math.floor(p.y), maxY = Math.floor(p.y + HEIGHT - 0.001);
    const minZ = Math.floor(p.z - WIDTH / 2), maxZ = Math.floor(p.z + WIDTH / 2);
    const EPS = 1e-4;
    for (let y = minY; y <= maxY; y++) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          if (!isSolid(this.world.getBlock(x, y, z))) continue;
          if (axis === 'y') {
            if (amount < 0) { p.y = y + 1; this.onGround = true; }
            else p.y = y - HEIGHT - EPS;
          } else if (axis === 'x') {
            p.x = amount > 0 ? x - WIDTH / 2 - EPS : x + 1 + WIDTH / 2 + EPS;
          } else {
            p.z = amount > 0 ? z - WIDTH / 2 - EPS : z + 1 + WIDTH / 2 + EPS;
          }
          this.vel[axis] = 0;
          return true;
        }
      }
    }
    return false;
  }

  update(dt) {
    const k = this.keys;
    const sprinting = k.has('shiftleft') || k.has('shiftright');
    let fx = 0, fz = 0;
    // forward is the camera's -Z at yaw 0, so W maps to +1 on this basis
    if (k.has('keyw') || k.has('arrowup')) fz += 1;
    if (k.has('keys') || k.has('arrowdown')) fz -= 1;
    if (k.has('keya') || k.has('arrowleft')) fx -= 1;
    if (k.has('keyd') || k.has('arrowright')) fx += 1;
    const len = Math.hypot(fx, fz) || 1;
    fx /= len; fz /= len;

    const waterHere = this.blockAtFeet() === WATER;
    this.inWater = waterHere;
    this.sprinting = sprinting && !this.flying;

    let speed = this.flying ? (sprinting ? 22 : 9) : (this.sprinting ? 7.4 : 4.7);
    if (waterHere && !this.flying) speed *= 0.62;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const dirX = fx * cos - fz * sin;
    const dirZ = -fx * sin - fz * cos;

    const accel = this.onGround || this.flying ? 14 : 4.2;
    this.vel.x += (dirX * speed - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (dirZ * speed - this.vel.z) * Math.min(1, accel * dt);

    if (this.flying) {
      let vy = 0;
      if (k.has('space')) vy += 1;
      if (k.has('controlleft') || k.has('keyc')) vy -= 1;
      this.vel.y += (vy * speed - this.vel.y) * Math.min(1, 12 * dt);
    } else if (waterHere) {
      this.vel.y -= GRAVITY * 0.28 * dt;
      if (k.has('space')) this.vel.y += 22 * dt;
      this.vel.y = Math.max(-4.5, Math.min(4.5, this.vel.y));
    } else {
      if (k.has('space') && this.onGround) {
        this.vel.y = JUMP_V;
        this.onGround = false;
      }
      this.vel.y -= GRAVITY * dt;
      if (this.vel.y < -TERMINAL) this.vel.y = -TERMINAL;
    }

    this.onGround = false;
    this.moveAxis('y', this.vel.y * dt);
    this.moveAxis('x', this.vel.x * dt);
    this.moveAxis('z', this.vel.z * dt);

    if (this.pos.y < -8) { this.spawnAt(this.pos.x, this.pos.z); this.vel.set(0, 0, 0); }
    this.unstick();

    const hspeed = Math.hypot(this.vel.x, this.vel.z);
    this.bob += dt * hspeed * 1.9;
    this.syncCamera();
  }

  /** Push the current player transform onto the camera. */
  syncCamera() {
    this.camera.position.set(this.pos.x, this.eyeY, this.pos.z);
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotateY(this.yaw);
    this.camera.rotateX(this.pitch);
  }

  /** Nudge the player out of solid rock (teleports can drop you inside a hill). */
  unstick() {
    const px = Math.floor(this.pos.x), py = Math.floor(this.pos.y), pz = Math.floor(this.pos.z);
    if (!isSolid(this.world.getBlock(px, py, pz))
      && !isSolid(this.world.getBlock(px, py + 1, pz))) return;
    const top = Math.floor(this.world.heightAt(px, pz));
    this.pos.y = Math.max(top + 1.2, py + 1);
    this.vel.set(0, 0, 0);
    this.onGround = true;
  }

  blockAtFeet() {
    return this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + 0.2), Math.floor(this.pos.z));
  }

  blockAtEyes() {
    return this.world.getBlock(Math.floor(this.pos.x), Math.floor(this.eyeY), Math.floor(this.pos.z));
  }

  /**
   * Amanatides & Woo voxel traversal.
   * @returns {{x:number,y:number,z:number,place:[number,number,number],id:number,dist:number}|null}
   */
  /** Unit look vector derived from yaw/pitch (independent of camera state). */
  lookDir(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  raycast(maxDist = this.reach) {
    const dir = this.lookDir();
    const ox = this.pos.x, oy = this.eyeY, oz = this.pos.z;
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = Math.sign(dir.x), stepY = Math.sign(dir.y), stepZ = Math.sign(dir.z);
    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;
    const bound = (p, s) => (s > 0 ? Math.floor(p) + 1 - p : p - Math.floor(p));
    let tMaxX = stepX !== 0 ? bound(ox, stepX) * tDeltaX : Infinity;
    let tMaxY = stepY !== 0 ? bound(oy, stepY) * tDeltaY : Infinity;
    let tMaxZ = stepZ !== 0 ? bound(oz, stepZ) * tDeltaZ : Infinity;
    let face = [0, 0, 0];
    let t = 0;
    for (let i = 0; i < 256; i++) {
      if (y >= 0 && y < CHUNK_Y) {
        const id = this.world.getBlock(x, y, z);
        if (id !== AIR && !isLiquid(id)) {
          return {
            x, y, z, id, dist: t, face,
            place: [x - face[0], y - face[1], z - face[2]],
          };
        }
      }
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; t = tMaxX; tMaxX += tDeltaX; face = [-stepX, 0, 0];
      } else if (tMaxY < tMaxZ) {
        y += stepY; t = tMaxY; tMaxY += tDeltaY; face = [0, -stepY, 0];
      } else {
        z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; face = [0, 0, -stepZ];
      }
      if (t > maxDist) break;
    }
    return null;
  }

  canPlaceAt(wx, wy, wz) {
    if (wy < 0 || wy >= CHUNK_Y) return false;
    const target = blocks[this.world.getBlock(wx, wy, wz)];
    if (!target.opaque && !target.liquid) {
      // never seal the player inside a block
      const px = this.pos.x, py = this.pos.y, pz = this.pos.z;
      const overlapX = wx + 1 > px - WIDTH / 2 && wx < px + WIDTH / 2;
      const overlapZ = wz + 1 > pz - WIDTH / 2 && wz < pz + WIDTH / 2;
      const overlapY = wy + 1 > py && wy < py + HEIGHT;
      if (overlapX && overlapY && overlapZ) return false;
      return true;
    }
    return false;
  }
}

export { WIDTH as PLAYER_WIDTH, HEIGHT as PLAYER_HEIGHT, EYE as PLAYER_EYE };
