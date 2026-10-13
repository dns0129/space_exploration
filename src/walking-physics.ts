import * as THREE from "three";
import type * as Rapier from "@dimforge/rapier3d-compat";
import type { WorldConfig } from "../shared/flight-state.mjs";
import { buildWalkingTerrain, terrainTopology, PATCH_HALF_EXTENT_M, PATCH_SPACING_M } from "./walking-terrain.ts";
import type { TerrainBuild } from "./walking-terrain.ts";
import type { BodyId } from "./solar-system";

// The compatibility distribution embeds its WASM, including in the offline HTML.
let initialization: Promise<void> | undefined;
let initialized = false;
let RAPIER: typeof import('@dimforge/rapier3d-compat').default;
export function initializeWalkingPhysics(): Promise<void> {
  return initialization ??= import("@dimforge/rapier3d-compat").then(async module => {
    RAPIER = module.default;
    await RAPIER.init();
    initialized = true;
  }).catch(error => { initialization = undefined; throw error; });
}
export const walkingPhysicsReady = () => initialized;

export const CHARACTER_RADIUS_M = 0.22;
export const CHARACTER_HALF_SEGMENT_M = 0.65;
export const CHARACTER_CONTACT_GAP_M = 0.01;
export const CHARACTER_CENTER_HEIGHT_M = CHARACTER_RADIUS_M + CHARACTER_HALF_SEGMENT_M + CHARACTER_CONTACT_GAP_M;
export const WALKING_PATCH_HALF_EXTENT_M = PATCH_HALF_EXTENT_M;
export const WALKING_PATCH_SPACING_M = PATCH_SPACING_M;
const PATCH_REFRESH_DISTANCE_M = 16;
const GROUND_RAY_EDGE_BIAS_M = 0.00001;
export const CAMERA_COLLISION_RADIUS_M = 0.2;
const CAMERA_TERRAIN_GAP_M = 0.02;
const CAMERA_SWEEP_RETREAT_M = 0.001;

/** Vertices are in the same metre frame as the character and are used verbatim by rendering. */
export interface WalkingTerrainPatch {
  vertices: Float32Array;
  renderPositions: Float32Array;
  renderRadials: Float32Array;
  renderColors: Float32Array;
  renderNormals: Float32Array;
  indices: Uint32Array;
  revision: number;
  centerLocalM: THREE.Vector3;
  centerRadialM: THREE.Vector3;
  right: THREE.Vector3;
  forward: THREE.Vector3;
  halfExtentM: number;
  radiusM: number;
}

/** Only the nearby metre-scale collision scene lives in Rapier, never astronomical positions. */
export class WalkingPhysics {
  readonly world: Rapier.World;
  readonly character: Rapier.RigidBody;
  readonly collider: Rapier.Collider;
  readonly controller: Rapier.KinematicCharacterController;
  terrainPatch!: WalkingTerrainPatch;
  private terrainCollider?: Rapier.Collider;
  private patchRevision = 0;
  collisionCount = 0;
  terrainWorkerState = 'fallback';
  private worker?: import('./walking-terrain-worker').WalkingTerrainWorker;
  private pendingBuild?: TerrainBuild;
  private building = false;
  private generation = 0;
  private disposed = false;
  private readonly lastRadial = new THREE.Vector3();
  private readonly terrainDelta = new THREE.Vector3();
  private readonly terrainTravel = new THREE.Vector3();
  readonly config: WorldConfig;
  readonly bodyId: BodyId;

  constructor(config: WorldConfig, bodyId: BodyId) {
    this.config = config;
    this.bodyId = bodyId;
    if (!initialized) throw new Error("Call initializeWalkingPhysics before creating the walking physics scene");
    // Character gravity is integrated radially by WalkingDynamics. A global -Y would double it.
    this.world = new RAPIER.World({ x: 0, y: 0, z: 0 });
    this.character = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased());
    this.collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(CHARACTER_HALF_SEGMENT_M, CHARACTER_RADIUS_M), this.character);
    this.controller = this.world.createCharacterController(CHARACTER_CONTACT_GAP_M);
    this.controller.setMaxSlopeClimbAngle(50 * Math.PI / 180);
    this.controller.setMinSlopeSlideAngle(50 * Math.PI / 180);
    this.controller.disableAutostep();
    this.controller.disableSnapToGround();
    if (typeof Worker !== 'undefined' && typeof document !== 'undefined') {
      this.terrainWorkerState = 'warming';
      void import('./walking-terrain-worker').then(async ({ WalkingTerrainWorker }) => {
        if (this.disposed) return;
        const worker = new WalkingTerrainWorker(this.config, this.bodyId);
        this.worker = worker;
        try { await worker.ready; if (!this.disposed) this.terrainWorkerState = 'ready'; }
        catch { worker.dispose(); this.worker = undefined; this.terrainWorkerState = 'fallback'; }
      }).catch(() => { this.terrainWorkerState = 'fallback'; });
    }
  }


  ensureTerrain(radialM: THREE.Vector3, originRadialM: THREE.Vector3, force = false) {
    const up = this.terrainTravel.copy(radialM).normalize();
    const displacement = this.terrainDelta.copy(radialM).sub(this.terrainPatch?.centerRadialM ?? radialM).projectOnPlane(up);
    const distance = displacement.length();
    const movingAway = this.terrainTravel.copy(radialM).sub(this.lastRadial).dot(displacement) > 0;
    this.lastRadial.copy(radialM);
    if (!force && this.terrainPatch) {
      if (this.worker && movingAway && distance >= 8 && !this.building && !this.pendingBuild) {
        const predicted = radialM.clone().addScaledVector(displacement.normalize(), 16);
        const generation = this.generation;
        this.building = true;
        void this.worker.build(predicted.toArray(), originRadialM.toArray()).then(result => {
          if (!this.disposed && generation === this.generation) this.pendingBuild = result;
        }).catch(() => {
          this.worker?.dispose(); this.worker = undefined; this.terrainWorkerState = 'fallback';
        }).finally(() => { if (generation === this.generation) this.building = false; });
      }
      if (distance < PATCH_REFRESH_DISTANCE_M) return false;
      if (this.pendingBuild) {
        const result = this.pendingBuild; this.pendingBuild = undefined;
        const ahead = new THREE.Vector3().fromArray(result.centerRadialM).sub(radialM).projectOnPlane(radialM.clone().normalize()).length();
        if (ahead < 32) { this.installTerrain(result, originRadialM); return true; }
      }
      // Retain valid collision underfoot while the worker prepares its successor.
      // Reversals, fast relocation, slow/failed workers have a synchronous safety fallback.
      if (this.worker && distance < 32) return false;
    }
    ++this.generation; this.pendingBuild = undefined; this.building = false;
    this.installTerrain(buildWalkingTerrain(this.config, this.bodyId, radialM.toArray(), originRadialM.toArray()), originRadialM);
    return true;
  }

  private installTerrain(result: TerrainBuild, originRadialM: THREE.Vector3) {
    const { vertices } = result, indices = terrainTopology();
    const shift = new THREE.Vector3().fromArray(result.originRadialM).sub(originRadialM);
    if (shift.lengthSq()) for (let i = 0; i < vertices.length; i += 3) {
      vertices[i] += shift.x; vertices[i + 1] += shift.y; vertices[i + 2] += shift.z;
    }
    const center = new THREE.Vector3().fromArray(result.centerRadialM);
    if (this.terrainCollider) this.world.removeCollider(this.terrainCollider, false);
    this.terrainCollider = this.world.createCollider(RAPIER.ColliderDesc.trimesh(
      new Float32Array(vertices), indices, RAPIER.TriMeshFlags.FIX_INTERNAL_EDGES));
    this.terrainPatch = { vertices, indices, renderPositions: result.renderPositions, renderRadials: result.renderRadials,
      renderColors: result.renderColors, renderNormals: result.renderNormals, revision: ++this.patchRevision,
      centerLocalM: center.clone().sub(originRadialM), centerRadialM: center,
      right: new THREE.Vector3().fromArray(result.right), forward: new THREE.Vector3().fromArray(result.forward),
      halfExtentM: WALKING_PATCH_HALF_EXTENT_M, radiusM: WALKING_PATCH_HALF_EXTENT_M };
    this.refreshQueries();
  }

  setFeet(feetM: THREE.Vector3, up: THREE.Vector3, orientation: THREE.Quaternion) {
    const center = feetM.clone().addScaledVector(up, CHARACTER_CENTER_HEIGHT_M);
    this.character.setTranslation(center, false);
    this.character.setNextKinematicTranslation(center);
    this.character.setRotation(orientation, false);
    this.character.setNextKinematicRotation(orientation);
    this.controller.setUp(up);
    this.world.propagateModifiedBodyPositionsToColliders();
  }

  move(feetM: THREE.Vector3, up: THREE.Vector3, orientation: THREE.Quaternion, desiredM: THREE.Vector3, dt: number) {
    this.setFeet(feetM, up, orientation);
    this.world.timestep = dt;
    this.controller.computeColliderMovement(this.collider, desiredM);
    const movement = new THREE.Vector3().copy(this.controller.computedMovement());
    this.collisionCount = this.controller.numComputedCollisions();
    const contactNormals: THREE.Vector3[] = [];
    // Dense, curved triangle meshes can report computedGrounded=false at an
    // internal edge despite a valid upward support contact. Use the controller's
    // actual swept contact normals as well, never an analytical height clamp.
    // Rapier's grounded flag can include contact with an unwalkable slope;
    // gameplay support requires an actual normal within the 50° limit.
    let supported = false;
    if (desiredM.dot(up) <= 0) for (let i = 0; i < this.collisionCount; i++) {
      const contact = this.controller.computedCollision(i);
      if (contact) {
        const n = new THREE.Vector3().copy(contact.normal1);
        contactNormals.push(n);
        if (n.dot(up) >= Math.cos(50 * Math.PI / 180)) supported = true;
      }
    }
    const center = this.character.translation();
    this.character.setNextKinematicTranslation(new THREE.Vector3().copy(center).add(movement));
    this.world.step();
    if (!supported && desiredM.dot(up) <= 0) {
      // A support-only sweep spans Rapier's 0.1 mm numerical buffer. It does
      // not move the character and prevents tiny last substeps toggling contact.
      this.controller.computeColliderMovement(this.collider, up.clone().multiplyScalar(-0.003));
      for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
        const contact = this.controller.computedCollision(i);
        if (contact && new THREE.Vector3().copy(contact.normal1).dot(up) >= Math.cos(50 * Math.PI / 180)) supported = true;
      }
    }
    return { movement, grounded: supported, contactNormals };
  }

  /** Translation only: no velocities, rotations, collider shapes or handles are changed. */
  shiftOrigin(shiftM: THREE.Vector3) {
    const velocities: { body: Rapier.RigidBody; linear: Rapier.Vector; angular: Rapier.Vector }[] = [];
    this.world.forEachRigidBody(body => {
      velocities.push({ body, linear: { ...body.linvel() }, angular: { ...body.angvel() } });
      const next = new THREE.Vector3().copy(body.nextTranslation()).sub(shiftM);
      body.setTranslation(new THREE.Vector3().copy(body.translation()).sub(shiftM), false);
      if (body.isKinematic()) body.setNextKinematicTranslation(next);
    });
    this.world.forEachCollider(collider => {
      if (!collider.parent()) collider.setTranslation(new THREE.Vector3().copy(collider.translation()).sub(shiftM));
    });
    if (this.terrainPatch) {
      const vertices = this.terrainPatch.vertices;
      for (let i = 0; i < vertices.length; i += 3) {
        vertices[i] -= shiftM.x; vertices[i + 1] -= shiftM.y; vertices[i + 2] -= shiftM.z;
      }
      this.terrainPatch.centerLocalM.sub(shiftM);
      this.terrainPatch.revision = ++this.patchRevision;
    }
    this.refreshQueries();
    for (const state of velocities) {
      state.body.setLinvel(state.linear, false);
      state.body.setAngvel(state.angular, false);
    }
  }

  groundDistanceM(feetM: THREE.Vector3, up: THREE.Vector3) {
    const origin = feetM.clone().addScaledVector(up, 2), down = up.clone().negate();
    const cast = (point: THREE.Vector3) => this.world.castRay(
      new RAPIER.Ray(point, down), 10000, true, undefined, undefined, this.collider);
    const hit = cast(origin);
    if (hit) return hit.timeOfImpact - 2;
    // An exact ray through a shared trimesh vertex may miss every adjoining
    // triangle in Rapier. Symmetric 10 µm tangent rays still sample the actual
    // collider, without moving the saved pose or substituting analytic terrain.
    if (!this.terrainPatch) return Number.POSITIVE_INFINITY;
    let total = 0, hits = 0;
    for (const direction of [this.terrainPatch.right, this.terrainPatch.forward]) for (const sign of [-1, 1]) {
      const adjacent = cast(origin.clone().addScaledVector(direction, sign * GROUND_RAY_EDGE_BIAS_M));
      if (adjacent) { total += adjacent.timeOfImpact - 2; hits++; }
    }
    return hits ? total / hits : Number.POSITIVE_INFINITY;
  }

  /** Query-only camera sphere sweep in the current floating metre frame. */
  constrainCamera(eyeM: THREE.Vector3, desiredM: THREE.Vector3, radiusM = CAMERA_COLLISION_RADIUS_M) {
    if (!this.terrainCollider) return desiredM.clone();
    const radius = Number.isFinite(radiusM) && radiusM > 0 ? radiusM : CAMERA_COLLISION_RADIUS_M;
    const sphere = new RAPIER.Ball(radius), rotation = { x: 0, y: 0, z: 0, w: 1 };
    const start = eyeM.clone();
    // The camera sphere extends slightly beyond the suit at eye height. Resolve
    // an initial overlap against the actual mesh, including a zero-length boom,
    // without moving the character or advancing Rapier/gameplay time.
    for (let i = 0; i < 4; i++) {
      const contact = this.terrainCollider.contactShape(sphere, start, rotation, CAMERA_TERRAIN_GAP_M);
      if (!contact || contact.distance >= CAMERA_TERRAIN_GAP_M) break;
      const normal = new THREE.Vector3().copy(contact.normal1);
      if (normal.lengthSq() < 1e-12) break;
      start.addScaledVector(normal.normalize(), CAMERA_TERRAIN_GAP_M - contact.distance + CAMERA_SWEEP_RETREAT_M);
    }
    const boom = desiredM.clone().sub(start), length = boom.length();
    if (length < 1e-8) return start;
    const hit = this.world.castShape(start, rotation, boom, sphere, CAMERA_TERRAIN_GAP_M, 1, true,
      undefined, undefined, this.collider, this.character,
      collider => collider.handle === this.terrainCollider!.handle);
    if (!hit) return desiredM.clone();
    const fraction = THREE.MathUtils.clamp(hit.time_of_impact - CAMERA_SWEEP_RETREAT_M / length, 0, 1);
    return start.addScaledVector(boom, fraction);
  }

  private refreshQueries() {
    // Rapier 0.19 builds scene queries during step. With no dynamic bodies, a zero-duration
    // refresh updates the broad phase without advancing gameplay time or changing velocity.
    const dt = this.world.timestep;
    this.world.timestep = 0;
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.step();
    this.world.timestep = dt;
  }

  dispose() { this.disposed = true; ++this.generation; this.worker?.dispose(); this.world.free(); }
}
