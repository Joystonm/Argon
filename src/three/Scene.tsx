/**
 * The 3D view.
 *
 * Renders `buildScene(project)` — a pure function of the canonical model — so
 * it is always the same building the 2D plan shows. An edit in either view
 * mutates the model; there is no synchronisation step because there is no
 * second copy to synchronise.
 *
 * Four cameras, one scene:
 *   orbit      exterior, free
 *   top-down   orthographic-ish plan check in 3D
 *   walk       first person, pointer-locked, outdoors, from the pavement
 *   inside     first person inside the building, drag to look, room to room
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport, Html as DreiHtml, OrbitControls, PointerLockControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import { useProject } from '../store/useProject.ts';
import { buildScene, EAVES_OVERHANG, STREET_DIR, frameFor, type Box, type SceneGeometry } from './sceneModel.ts';
import { materialFor, primitiveGeometry, skyTexture, surfaceRepeat } from './textures.ts';
import {
  CAMERA_RADIUS,
  EYE_HEIGHT,
  LOOK_SENSITIVITY,
  PITCH_LIMIT,
  TURN_RATE,
  WALK_VERGE,
  canViewFromInside,
  clampToPlot,
  defaultInteriorRoom,
  moveWithCollision,
  roomAt,
  roomViewpoint,
  shortestAngle,
  walkStart,
  type RoomRect,
} from './collision.ts';

export type CameraMode = 'orbit' | 'top' | 'walk' | 'inside';

export interface SceneProps {
  cameraMode: CameraMode;
  showFurniture: boolean;
  showRoof: boolean;
  visibleFloorIds: string[] | null;
  onSelect?: (ownerId: string, kind: string) => void;
  /** Reports which room the inside camera is standing in. Fires on change. */
  onInsideRoom?: (label: string | null) => void;
}

/** Vertical field of view for each camera. Set imperatively — see `FirstPerson`. */
const WALK_FOV = 68;
const ORBIT_FOV = 38;
/**
 * Inside is wider than walk on purpose: you are a room away from the walls
 * rather than a building away, and the walls are the subject.
 */
const INSIDE_FOV = 75;
/** Degrees to radians. `roomViewpoint` reports in degrees, because that is how
 *  the room labels and the compass are written; the running camera state is in
 *  radians, because `camera.rotation` is. Everything crossing that boundary goes
 *  through here — mixing the two silently is what put the view on the floor. */
const DEG = Math.PI / 180;

// ─────────────────────────────────────────────────────────────── the boxes ────

/** Kinds that are the site rather than the building: flat, and never pickable. */
const SITE_KINDS = new Set(['lawn', 'paving', 'path']);

function BoxMesh({ box, onSelect }: { box: Box; onSelect?: (id: string, kind: string) => void }) {
  const selection = useProject((s) => s.selection);
  const selected = box.ownerId ? selection.ids.includes(box.ownerId) : false;
  const [hovered, setHovered] = useState(false);
  const site = SITE_KINDS.has(box.kind);

  // Texture scale follows the part, so a 20 m roof and a 20 cm drawer front get
  // the same physical grain rather than the same single tile of picture.
  //
  // A box has three dimensions but each of its six faces shows two of them, and
  // which two depends on which way up the box is: a wall is drawn as length ×
  // height, a floor slab as length × depth. Taking the two *largest* dimensions
  // picks the right pair in both cases and is right for the narrow side faces
  // too, since those are strips a couple of centimetres across either way.
  //
  // This used to take the width and the height, which is exactly right for a
  // wall and badly wrong for anything flat. The lawn is a 30 m × 26 m slab ten
  // centimetres thick, so its second dimension came out as 0.1 m: the repeat
  // along that axis bottomed out at half a tile while the other ran to twelve,
  // and a map stretched fiftyfold in one direction and tiled twelve times in
  // the other is not grass. It came out combed into long furrows running away
  // from the camera. The roof and the paving were smeared the same way.
  const repeat = useMemo(() => {
    if (!box.surface) return null;
    const dims = [box.w, box.h, box.d].sort((a, b) => b - a);
    return surfaceRepeat(dims[0]!, dims[1]!);
  }, [box.surface, box.w, box.d, box.h]);

  // Hover and selection tint the surface rather than replacing the material,
  // so a highlighted sofa still has its fabric grain while it is highlighted.
  const material = useMemo(
    () =>
      materialFor({
        surface: box.surface,
        color: selected ? '#9db9e6' : hovered ? '#dcd6c6' : box.color,
        roughness: box.roughness,
        metalness: box.metalness,
        opacity: box.opacity,
        glass: box.glass,
        repeat: repeat ?? undefined,
      }),
    [box.surface, box.color, box.roughness, box.metalness, box.opacity, box.glass, selected, hovered, repeat],
  );

  const rotation: [number, number, number] = [
    ((box.rx ?? 0) * Math.PI) / 180,
    (box.ry * Math.PI) / 180,
    ((box.rz ?? 0) * Math.PI) / 180,
  ];

  // Geometry is cached and shared by every identical part — a house full of
  // cushions wants one cushion mesh's worth of vertices, not forty. It is
  // passed as a prop rather than as a `<primitive>` child because a shared
  // object handed to `<primitive>` is owned by the renderer, and one mesh
  // unmounting takes the geometry out from under the others still using it.
  const geometry = useMemo(
    () => primitiveGeometry(box.shape, box.w, box.h, box.d, box.round ?? 0),
    [box.shape, box.w, box.h, box.d, box.round],
  );

  return (
    <mesh
      position={[box.x, box.y, box.z]}
      rotation={rotation}
      geometry={geometry}
      material={material}
      castShadow={!site && box.kind !== 'glass'}
      receiveShadow
      onClick={(e) => {
        if (site) return;
        e.stopPropagation();
        if (box.ownerId) onSelect?.(box.ownerId, box.kind);
      }}
      onPointerOver={(e) => {
        if (site) return;
        e.stopPropagation();
        setHovered(true);
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        setHovered(false);
        document.body.style.cursor = '';
      }}
    />
  );
}

/** Everything the model says, as one batch of instanced-looking meshes. */
function Building({ boxes, onSelect }: { boxes: Box[]; onSelect?: (id: string, kind: string) => void }) {
  return (
    <group>
      {boxes.map((b, i) => (
        <BoxMesh key={`${b.kind}:${b.ownerId ?? 'x'}:${i}`} box={b} onSelect={onSelect} />
      ))}
    </group>
  );
}

// ─────────────────────────────────────────────────────────────── ground ───────

function Ground({ width, depth, setbacks }: { width: number; depth: number; setbacks: { front: number; rear: number; left: number; right: number } }) {
  const buildableW = Math.max(0, width - setbacks.left - setbacks.right);
  const buildableD = Math.max(0, depth - setbacks.front - setbacks.rear);
  return (
    <group>
      {/* The far ground, out past the lawn the scene model draws. Its own edge
          used to land inside the fog's near distance, so the site ended on a
          hard diagonal line against the sky; it now runs far enough out that
          the fog closes over it first. It is deliberately not *too* far: at
          forty plot-widths the plane reached three hundred and sixty metres
          and the fog had a hundred and sixty-five to work with, so almost the
          whole middle distance stayed full-saturation green and the backdrop
          read as one flat field of lawn behind the house rather than as land
          running away into haze. Twenty plot-widths puts the horizon where the
          fog has already closed, so the green band ends in distance instead of
          ending at the edge of the world. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.36, 0]} receiveShadow>
        <planeGeometry args={[Math.max(width, depth) * 20, Math.max(width, depth) * 20]} />
        {/* Matched to the lawn the scene model draws. A different green here
            meant the building's cast shadow fell across two surfaces of clearly
            different hue, so shaded ground read as a grey slab laid over the
            site rather than as grass in shade. */}
        <meshStandardMaterial color="#a5af8a" roughness={1} />
      </mesh>
      {/* Setback boundary, the one line on site that is genuinely a rule. */}
      <lineSegments position={[0, -0.24, 0]}>
        <edgesGeometry args={[new THREE.PlaneGeometry(buildableW, buildableD).rotateX(-Math.PI / 2)]} />
        <lineBasicMaterial color="#8e8778" />
      </lineSegments>
    </group>
  );
}

// ─────────────────────────────────────────────────────────── first person ─────

interface WalkState {
  pos: { x: number; y: number; z: number };
  vel: { x: number; z: number };
  keys: Record<string, boolean>;
}

function FirstPerson({
  colliders,
  plot,
  building,
  street,
  onExit,
}: {
  colliders: ReturnType<typeof buildScene>['colliders'];
  plot: { width: number; depth: number };
  building: SceneGeometry['building'];
  street: { x: number; z: number };
  onExit: () => void;
}) {
  const { camera, size } = useThree();
  const state = useRef<WalkState>({ pos: { x: 0, y: EYE_HEIGHT, z: 0 }, vel: { x: 0, z: 0 }, keys: {} });
  const [hud, setHud] = useState({ locked: false, touching: false });

  // Start on the pavement, back from the front wall, looking at the house.
  //
  // This used to be a fixed `plot.depth / 2 + 2.4`, which the per-frame clamp
  // then dragged back inside the plot on the very next frame — a 3 m teleport
  // that put the camera inside the front wall. `walkStart` derives the position
  // from the geometry and the viewport's own field of view instead, and
  // guarantees it is clear of every collider.
  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    // The Canvas declares a different fov per mode, but R3F only applies that
    // to the camera when it creates it — switching modes left the camera on
    // the orbit camera's 38°. Framing was computed for 68°, so walk mode came
    // out at nearly twice the intended closeness: a wall at point-blank range.
    if (persp.fov !== WALK_FOV) {
      persp.fov = WALK_FOV;
      persp.updateProjectionMatrix();
    }
    const aspect = size.width / Math.max(1, size.height);
    const start = walkStart(building, plot, colliders, CAMERA_RADIUS, aspect, WALK_FOV, street);
    state.current.pos = { x: start.x, y: EYE_HEIGHT, z: start.z };
    state.current.vel = { x: 0, z: 0 };
    camera.position.set(start.x, EYE_HEIGHT, start.z);
    camera.lookAt(building.cx, EYE_HEIGHT, building.cz);
    // Keyed on the geometry, not the collider array, or every new piece of
    // furniture would yank the camera back to the doorstep mid-walk.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, size.width, size.height, building.minX, building.maxX, building.minZ, building.maxZ, building.cx, building.cz, building.width, building.height, plot.width, plot.depth, street.x, street.z]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return;
      state.current.keys[e.code] = true;
    };
    const up = (e: KeyboardEvent) => {
      state.current.keys[e.code] = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  // drei hands PointerLockControls a DOM Event, not a boolean, so read the
  // document state instead of trusting the argument's type.
  const onLock = () => {
    const locked = typeof document !== 'undefined' && document.pointerLockElement !== null;
    setHud((h) => ({ ...h, locked }));
    if (!locked) onExit();
  };

  useFrame((_, delta) => {
    const s = state.current;
    const k = s.keys;
    const boost = k['ShiftLeft'] || k['ShiftRight'] ? 2.1 : 1;
    // Velocity in m/s. `step` is the frame time, capped only so that a tab
    // which was backgrounded does not integrate seconds of movement at once.
    // It is applied exactly once, when converting velocity to this frame's
    // displacement — applying it to `speed` as well made the camera move at
    // about 1/60th of the speed the HUD advertises.
    const step = Math.min(3, delta);
    const speed = 2.6 * boost;

    // Forward is -Z in camera space; yaw comes from the pointer lock.
    const forward = (k['KeyW'] || k['ArrowUp'] ? 1 : 0) - (k['KeyS'] || k['ArrowDown'] ? 1 : 0);
    const strafe = (k['KeyD'] || k['ArrowRight'] ? 1 : 0) - (k['KeyA'] || k['ArrowLeft'] ? 1 : 0);

    // The camera looks down its local -Z, so yaw is just its Y rotation.
    // Reading it back out of the world matrix was roundabout and wrong once
    // the user pitches the view.
    const yaw = camera.rotation.y;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);

    const wishX = (-sin * forward + cos * strafe) * speed;
    const wishZ = (-cos * forward - sin * strafe) * speed;

    // Critically-damped-ish smoothing so starting and stopping feel weighted.
    s.vel.x += (wishX - s.vel.x) * Math.min(1, delta * 12);
    s.vel.z += (wishZ - s.vel.z) * Math.min(1, delta * 12);

    const clamped = clampToPlot(s.pos.x, s.pos.z, plot, 0.6, WALK_VERGE);
    const moved = moveWithCollision(clamped.x, clamped.z, s.vel.x * step, s.vel.z * step, colliders, CAMERA_RADIUS);

    s.pos.x = moved.x;
    s.pos.z = moved.z;
    if (moved.touching) {
      setHud((h) => (h.touching ? h : { ...h, touching: true }));
    } else if (hud.touching) {
      setHud((h) => ({ ...h, touching: false }));
    }

    camera.position.set(moved.x, s.pos.y, moved.z);
  });

  return (
    <group>
      {/* `selector` matters, and not for tidiness. drei attaches the
          lock trigger to `document` when it is omitted, which means a click
          anywhere in the application — toolbar, navigator, assistant panel —
          calls `requestPointerLock()` on the 3D canvas. When such a click is
          also what leaves walk mode, React has already detached the canvas by
          the time the event finishes bubbling, the request rejects, and
          three-stdlib does not catch it: an unhandled rejection that the
          end-to-end run caught intermittently as a `WrongDocumentError`.
          Scoping the trigger to this view means the listener lives on the
          wrapper div, a detached canvas can never be reachable through it, and
          "click to walk" means what the HUD says it means. */}
      <PointerLockControls selector=".argon-3d-view" onLock={onLock} onUnlock={onLock} makeDefault />

      {!hud.locked && (
        <Hud>
          <p className="font-medium text-stone-800">Click to walk</p>
          <p className="mt-1 text-stone-500">W A S D to move · Shift to run · Esc to leave</p>
          <p className="mt-1 text-stone-500">Walls and furniture stop you.</p>
        </Hud>
      )}
      {hud.touching && hud.locked && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded bg-stone-900/80 px-3 py-1.5 text-[12px] text-white">
          Blocked — turn or step back
        </div>
      )}
    </group>
  );
}

function Hud({ children }: { children: React.ReactNode }) {
  return (
    <DreiHtml center>
      <div className="pointer-events-none w-64 rounded-lg border border-stone-200 bg-white/95 px-4 py-3 text-center text-[12px] shadow-lg backdrop-blur">
        {children}
      </div>
    </DreiHtml>
  );
}

// ──────────────────────────────────────────────────────────────── inside ─────

/** Seconds a move to another room takes. Long enough to read as travel. */
const FLIGHT_SECONDS = 0.75;

/** Smoothstep, so a flight eases in and out instead of starting and stopping. */
const ease = (t: number): number => t * t * (3 - 2 * t);

interface Flight {
  /** Metres for position, radians for orientation. */
  from: { x: number; y: number; z: number; yaw: number; pitch: number };
  to: { x: number; y: number; z: number; yaw: number; pitch: number };
  t: number;
}

interface InsideState {
  pos: { x: number; y: number; z: number };
  vel: { x: number; z: number };
  keys: Record<string, boolean>;
  /**
   * Radians, always — it goes straight into `camera.rotation` every frame, and
   * `PITCH_LIMIT`, `LOOK_SENSITIVITY` and `TURN_RATE` are all radian quantities
   * too. A viewpoint arrives from `roomViewpoint` in degrees and is converted
   * on the way in.
   */
  look: { yaw: number; pitch: number };
  /** Which storey the camera is on, so the ground floor cannot block it. */
  floorId: string | null;
  flight: Flight | null;
  /** Forward drive from the scroll wheel, decaying to zero every frame. */
  push: number;
  dragging: boolean;
  /** Where the current drag was pressed. Kept until the click it may cancel. */
  downAt: { x: number; y: number } | null;
  /** The last pointer position, for computing this move's delta. */
  lastAt: { x: number; y: number } | null;
  /** Last reported position, so the room readout is not recomputed every frame. */
  checkedAt: { x: number; z: number } | null;
  room: string | null;
}

/**
 * First person, indoors.
 *
 * The difference from `FirstPerson` is the mouse. Pointer lock is the right
 * answer outdoors — a walk-through wants to face where you are going without
 * the cursor getting in the way — and the wrong answer indoors, where the user
 * still has to reach the toolbar, the room list and the inspector. Dragging to
 * look keeps the cursor, so the whole application stays reachable from a view
 * you are standing in the middle of.
 *
 * Which means dragging must not also click. React's capture phase is the hook:
 * a listener on the 3D view's own wrapper runs before the canvas's own
 * listeners, so stopping propagation there means a drag that ends over the
 * building never reaches the raycaster. Whether a press became a drag is
 * decided by how far the pointer travelled between press and release, which —
 * unlike a flag cleared on pointerup — cannot go stale if the release lands
 * outside the view and no click event follows.
 */
function InsideView({
  colliders,
  plot,
  rooms,
  frame,
  elevationOf,
  floorOrder,
  building,
  selectedRoomId,
  onInsideRoom,
}: {
  colliders: ReturnType<typeof buildScene>['colliders'];
  plot: { width: number; depth: number };
  rooms: RoomRect[];
  frame: ReturnType<typeof frameFor>;
  elevationOf: Map<string, number>;
  floorOrder: Map<string, number>;
  building: SceneGeometry['building'];
  selectedRoomId: string | null;
  onInsideRoom?: (label: string | null) => void;
}) {
  const { camera, gl } = useThree();
  const state = useRef<InsideState>({
    pos: { x: 0, y: EYE_HEIGHT, z: 0 },
    vel: { x: 0, z: 0 },
    keys: {},
    look: { yaw: 0, pitch: 0 },
    floorId: null,
    flight: null,
    push: 0,
    dragging: false,
    downAt: null,
    lastAt: null,
    checkedAt: null,
    room: null,
  });

  const viewpointFor = useCallback(
    (room: RoomRect) =>
      roomViewpoint(room, frame, {
        elevation: elevationOf.get(room.floorId) ?? 0,
        buildingCentre: { x: building.cx, z: building.cz },
        colliders: colliders.filter((c) => c.floorId === room.floorId),
        radius: CAMERA_RADIUS,
        eyeHeight: EYE_HEIGHT,
      }),
    [frame, elevationOf, building.cx, building.cz, colliders],
  );

  const beginFlight = useCallback(
    (room: RoomRect) => {
      const s = state.current;
      const to = viewpointFor(room);
      s.floorId = room.floorId;
      s.vel = { x: 0, z: 0 };
      s.push = 0;
      s.flight = {
        from: { ...s.pos, yaw: s.look.yaw, pitch: s.look.pitch },
        // Shortest way round, so crossing the ±180° seam is a two-degree turn.
        to: {
          ...to,
          yaw: s.look.yaw + shortestAngle(s.look.yaw / DEG, to.yaw) * DEG,
          pitch: to.pitch * DEG,
        },
        t: 0,
      };
    },
    [viewpointFor],
  );

  /**
   * The room the camera was last sent to, so the effect below only reacts to a
   * *change* of room. Initialised by the mount effect rather than by a null
   * sentinel here: "no room is selected" is itself a perfectly ordinary value,
   * and a `null` that means both "not started" and "nothing selected" swallows
   * the first room the user actually picks.
   */
  const lastSelected = useRef<string | null>(null);

  // This component is mounted only while the mode is active, so "run once" is
  // "run when the user enters the mode" — which is exactly right, and stops a
  // new piece of furniture from yanking the camera out of the room it is in.
  useEffect(() => {
    const persp = camera as THREE.PerspectiveCamera;
    if (persp.fov !== INSIDE_FOV) {
      persp.fov = INSIDE_FOV;
      persp.updateProjectionMatrix();
    }
    const chosen =
      (selectedRoomId ? rooms.find((r) => r.id === selectedRoomId) : null) ??
      defaultInteriorRoom(rooms, floorOrder);
    lastSelected.current = selectedRoomId;
    if (!chosen) return;
    // Land there without a flight: entering the mode is a jump, not a move.
    const to = viewpointFor(chosen);
    const s = state.current;
    s.floorId = chosen.floorId;
    s.pos = { x: to.x, y: to.y, z: to.z };
    s.look = { yaw: to.yaw * DEG, pitch: to.pitch * DEG };
    camera.position.set(to.x, to.y, to.z);
    camera.rotation.set(to.pitch * DEG, to.yaw * DEG, 0, 'YXZ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selecting a room — in the 3D view or in the plan beside it — moves the
  // camera there. Anything else selected does not: clicking a wall should not
  // teleport the viewer out of the room they are standing in.
  useEffect(() => {
    if (!selectedRoomId || selectedRoomId === lastSelected.current) return;
    lastSelected.current = selectedRoomId;
    const room = rooms.find((r) => r.id === selectedRoomId);
    if (room && canViewFromInside(room)) beginFlight(room);
  }, [selectedRoomId, rooms, beginFlight]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      state.current.keys[e.code] = true;
      // Any intent to move takes over from a flight in progress.
      if (/^(Key[WASDQE]|Arrow|Shift)/.test(e.code)) state.current.flight = null;
    };
    const up = (e: KeyboardEvent) => {
      state.current.keys[e.code] = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  useEffect(() => {
    const host = (gl.domElement.closest('.argon-3d-view') as HTMLElement | null) ?? gl.domElement;
    const s = state.current;

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      s.dragging = true;
      s.downAt = { x: e.clientX, y: e.clientY };
      s.lastAt = { x: e.clientX, y: e.clientY };
    };
    const onMove = (e: PointerEvent) => {
      if (!s.dragging || !s.lastAt) return;
      s.look.yaw -= (e.clientX - s.lastAt.x) * LOOK_SENSITIVITY;
      s.look.pitch -= (e.clientY - s.lastAt.y) * LOOK_SENSITIVITY;
      s.lastAt = { x: e.clientX, y: e.clientY };
      s.flight = null;
    };
    // `downAt` deliberately survives the release: the click event the browser
    // fires next is what it is compared against.
    const onUp = () => {
      s.dragging = false;
      s.lastAt = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      s.push = Math.max(-1, Math.min(1, s.push - e.deltaY * 0.0012));
      s.flight = null;
    };
    // Capture phase, on the wrapper rather than the canvas. See the docstring.
    const swallowClick = (e: MouseEvent) => {
      const down = s.downAt;
      s.downAt = null;
      if (!down) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4) return;
      e.stopPropagation();
      e.preventDefault();
    };

    host.style.touchAction = 'none';
    host.addEventListener('pointerdown', onDown);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('click', swallowClick, true);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      host.style.touchAction = '';
      host.removeEventListener('pointerdown', onDown);
      host.removeEventListener('wheel', onWheel);
      host.removeEventListener('click', swallowClick, true);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [gl]);

  useFrame((_, delta) => {
    const s = state.current;
    // Applied exactly once, when converting velocity to this frame's
    // displacement — see `FirstPerson`.
    const step = Math.min(3, delta);

    if (s.flight) {
      const f = s.flight;
      f.t = Math.min(1, f.t + step / FLIGHT_SECONDS);
      const e = ease(f.t);
      s.pos.x = f.from.x + (f.to.x - f.from.x) * e;
      s.pos.y = f.from.y + (f.to.y - f.from.y) * e;
      s.pos.z = f.from.z + (f.to.z - f.from.z) * e;
      s.look.yaw = f.from.yaw + (f.to.yaw - f.from.yaw) * e;
      s.look.pitch = f.from.pitch + (f.to.pitch - f.from.pitch) * e;
      if (f.t >= 1) s.flight = null;
    } else {
      const k = s.keys;
      const turn = (k['KeyQ'] ? 1 : 0) - (k['KeyE'] ? 1 : 0);
      if (turn) s.look.yaw += turn * TURN_RATE * step;

      const boost = k['ShiftLeft'] || k['ShiftRight'] ? 1.9 : 1;
      // Indoors is slower than outdoors: these rooms are two and a half metres
      // across, and a 2.6 m/s sprint crosses one before it can be read.
      const speed = 1.9 * boost;
      const forward =
        (k['KeyW'] || k['ArrowUp'] ? 1 : 0) - (k['KeyS'] || k['ArrowDown'] ? 1 : 0) + s.push;
      const strafe = (k['KeyD'] || k['ArrowRight'] ? 1 : 0) - (k['KeyA'] || k['ArrowLeft'] ? 1 : 0);

      // Radians already — see `InsideState.look`.
      const yaw = s.look.yaw;
      const sin = Math.sin(yaw);
      const cos = Math.cos(yaw);
      const wishX = (-sin * forward + cos * strafe) * speed;
      const wishZ = (-cos * forward - sin * strafe) * speed;

      s.vel.x += (wishX - s.vel.x) * Math.min(1, delta * 12);
      s.vel.z += (wishZ - s.vel.z) * Math.min(1, delta * 12);
      s.push *= Math.max(0, 1 - delta * 6);

      // No verge, unlike walk mode: there is nothing outside to walk to, and
      // the margin walk mode needs to keep its camera off the pavement would
      // here only let the viewer step through an outside wall.
      const clamped = clampToPlot(s.pos.x, s.pos.z, plot, 0.6, 0);
      const floorId = s.floorId;
      const moved = moveWithCollision(
        clamped.x,
        clamped.z,
        s.vel.x * step,
        s.vel.z * step,
        colliders,
        CAMERA_RADIUS,
        // Only this storey's furniture. Collision is tested on the XZ plane, so
        // without the filter the ground floor's sofa blocks the first floor.
        (c) => !floorId || !c.floorId || c.floorId === floorId,
      );
      s.pos.x = moved.x;
      s.pos.z = moved.z;
    }

    s.look.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, s.look.pitch));
    // YXZ, so pitch is applied about the camera's own axis: with the default
    // XYZ order, looking up also rolls the heading and the horizon tilts.
    camera.rotation.set(s.look.pitch, s.look.yaw, 0, 'YXZ');
    camera.position.set(s.pos.x, s.pos.y, s.pos.z);

    // Which room am I in? Recomputed when the camera has actually moved — a
    // readout that calls back into React every frame would re-render the whole
    // view sixty times a second to say nothing new.
    const moved = !s.checkedAt || Math.hypot(s.pos.x - s.checkedAt.x, s.pos.z - s.checkedAt.z) > 0.05;
    if (moved) {
      s.checkedAt = { x: s.pos.x, z: s.pos.z };
      const label = roomAt(s.pos.x, s.pos.z, rooms, frame, s.floorId ?? undefined)?.label ?? null;
      if (label !== s.room) {
        s.room = label;
        onInsideRoom?.(label);
      }
    }
  });

  return null;
}

// ───────────────────────────────────────────────────────────── camera rigs ────

/**
 * Orbit and top-down framing.
 *
 * Both are framed on the **building**, not the plot. Framing on the plot meant
 * that a modest house on a generous plot sat in the middle of an empty field
 * with the setback line as the only other thing on screen, and a large plot
 * pushed the building off-centre entirely. The distance is now derived from the
 * diagonal the camera actually has to fit, plus the height it has to clear, and
 * the target is the centre of the built fabric.
 */
function Rig({ mode, building, street }: { mode: CameraMode; building: SceneGeometry['building']; street: { x: number; z: number } }) {
  const { camera, size } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);

  // A plan with no walls yet has no extent to frame. Fall back to the plot
  // rather than dividing by zero, so the camera still lands somewhere sane.
  const w = Math.max(building.width, 6);
  const d = Math.max(building.depth, 6);
  const h = Math.max(building.height, 3);
  const target: [number, number, number] = [building.cx, Math.min(building.cy, h / 2), building.cz];

  // A three-quarter view from above eye height, opened from the *street* side.
  //
  // Viewing from a fixed compass bearing meant that for the default orientation
  // the app showed the back of the house — no entrance, no path, and the
  // elevation that matters least. `lateral` is the screen-right axis of that
  // view, and it is computed up front because both the framing and the sun
  // depend on it.
  const lateral = useMemo(
    () => new THREE.Vector3(-street.z, 0, street.x).normalize(),
    [street.x, street.z],
  );
  const viewDir = useMemo(
    () => new THREE.Vector3(street.x, 0, street.z).addScaledVector(lateral, 0.72).setY(0.45).normalize(),
    [street.x, street.z, lateral],
  );

  useEffect(() => {
    const aspect = Math.max(0.2, size.width / Math.max(1, size.height));
    const persp = camera as THREE.PerspectiveCamera;
    // Symmetrically: leaving walk mode puts the narrow field of view back, so
    // the orbit view is framed against the fov it is actually rendered with.
    if (persp.fov !== ORBIT_FOV) {
      persp.fov = ORBIT_FOV;
      persp.updateProjectionMatrix();
    }
    const vFov = (ORBIT_FOV * Math.PI) / 180;
    // The binding constraint is the *narrow* axis. This viewport is often
    // taller than it is wide, so the horizontal field of view can be much the
    // smaller of the two — framing off the vertical one put the camera inside
    // the front wall of its own house and cropped the roof off the screen.
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    // Fit the actual corners, not a bounding sphere.
    //
    // Framing off one distance for the whole building cannot work in
    // perspective: the near corner is half the building's depth nearer than the
    // target, so it is magnified while the far corner is not. A distance that
    // fits the far corner crops the near one off both edges of the frame — which
    // is exactly what a "projected width" fit does too.
    //
    // For a corner at offset (u across, v up, w toward the camera) from the
    // target, it is inside the frustum at distance D iff |u| ≤ (D − w)·tan(hFov/2)
    // and |v| ≤ (D − w)·tan(vFov/2) — so each corner states its own minimum D,
    // and the camera takes the largest.
    const tanH = Math.tan(hFov / 2);
    const tanV = Math.tan(vFov / 2);
    const e = EAVES_OVERHANG;
    const dist = (() => {
      // Straight down there is no perspective foreshortening to compensate for,
      // so the plan's own half-extents are the fit.
      if (mode === 'top') {
        return Math.max((w / 2 + e) / tanH, (d / 2 + e) / tanV) * 1.06;
      }
      const right = new THREE.Vector3(-viewDir.z, 0, viewDir.x).normalize();
      const up = new THREE.Vector3().crossVectors(right, viewDir).normalize();
      let need = 0;
      for (const x of [building.minX - e, building.maxX + e]) {
        for (const z of [building.minZ - e, building.maxZ + e]) {
          for (const y of [-e, building.height + e]) {
            const dx = x - target[0];
            const dy = y - target[1];
            const dz = z - target[2];
            const toward = dx * viewDir.x + dy * viewDir.y + dz * viewDir.z;
            const across = dx * right.x + dz * right.z;
            const upOff = dx * up.x + dy * up.y + dz * up.z;
            need = Math.max(need, toward + Math.max(Math.abs(across) / tanH, Math.abs(upOff) / tanV));
          }
        }
      }
      // Air around the subject. A corner-exact fit puts the eaves on the top
      // edge of the viewport and the near corner on the bottom one, which reads
      // as a photograph taken through a letterbox rather than as a building on
      // a site. The margin is the difference between "fitted" and "framed".
      return need * 1.16;
    })();

    if (mode === 'top') {
      // Straight down is a degenerate `lookAt`: with the default up vector of
      // +Y the cross product collapses and three picks an arbitrary roll, which
      // is why the top view used to come up rotated 45°. Declaring +Z as up
      // first puts plan-north at the top of the screen, which is what a plan
      // check is for.
      camera.up.set(0, 0, -1);
      camera.position.set(target[0], target[1] + dist, target[2]);
      camera.lookAt(target[0], target[1], target[2]);
      camera.up.set(0, 1, 0);
      controls.current?.target.set(...target);
      controls.current?.update();
    } else {
      camera.position.set(
        target[0] + viewDir.x * dist,
        target[1] + viewDir.y * dist,
        target[2] + viewDir.z * dist,
      );
      camera.lookAt(...target);
      controls.current?.target.set(...target);
      controls.current?.update();
    }
  }, [mode, camera, size.width, size.height, w, d, h, target[0], target[1], target[2], street.x, street.z, lateral, viewDir]);

  if (mode === 'walk' || mode === 'inside') return null;

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enableDamping
      dampingFactor={0.08}
      minDistance={1.5}
      maxDistance={Math.max(w, d) * 8}
      // Looking straight down is the top-down mode; stop just short so the
      // camera never flips through the ground.
      maxPolarAngle={Math.PI / 2 - 0.03}
      target={target}
    />
  );
}

// ───────────────────────────────────────────────────────────────── scene ─────

export function Scene({ cameraMode, showFurniture, showRoof, visibleFloorIds, onSelect, onInsideRoom }: SceneProps) {
  const project = useProject((s) => s.project);
  const selectedRoomId = useProject((s) => (s.selection.kinds.includes('room') ? (s.selection.ids[0] ?? null) : null));
  const geometry = useMemo(
    () => buildScene(project, { showFurniture, showRoof, visibleFloorIds: visibleFloorIds ?? undefined }),
    [project, showFurniture, showRoof, visibleFloorIds],
  );
  const frame = useMemo(
    () => frameFor(project.plot.width, project.plot.depth),
    [project.plot.width, project.plot.depth],
  );
  const elevationOf = useMemo(
    () => new Map(project.floors.map((f) => [f.id, f.elevation] as const)),
    [project.floors],
  );
  const floorOrder = useMemo(
    () => new Map(project.floors.map((f) => [f.id, f.order] as const)),
    [project.floors],
  );

  const shadows = geometry.bounds.height > 0.5;
  // Fit the shadow camera to the whole site, not just the building. Anything
  // outside this box is simply not shadowed, and the boundary shows as a hard
  // straight line across the lawn — which is worse than having no shadow at all.
  // The margin covers the cast shadow of the eaves, which reaches well past the
  // wall line.
  // Wide enough to cover the plot plus the reach of the building's own shadow.
  const shadowSpan = Math.max(15, Math.hypot(project.plot.width, project.plot.depth) / 2 + 6);
  const street = STREET_DIR[project.plot.orientation] ?? STREET_DIR[0]!;
  // Over the street but on the *opposite* side from the orbit camera, at
  // roughly 49° above the horizon — high enough that the cast shadow is a
  // shape on the lawn rather than a slab across the whole foreground, low
  // enough that the roof still has a lit plane and a shaded one.
  //
  // Putting the sun on the camera's own side was the single worst thing about
  // the old lighting: the front elevation went flat, and — because a shadow
  // always falls away from the sun — the whole cast shadow landed behind the
  // building, where the default view never sees it. The app showed a building
  // that looked pasted onto a lawn. Sun across the view rakes the shadow into
  // the foreground and puts the front in light and the return face in shade.
  const right = new THREE.Vector3(-street.z, 0, street.x).normalize();
  const sunDir = new THREE.Vector3(street.x, 0, street.z)
    .addScaledVector(right, -0.78)
    .setY(0.95)
    .normalize();

  // The fill comes from the opposite side of the sun, so the shaded elevation
  // keeps some modelling instead of going flat and dead.
  const shadowDir = new THREE.Vector3(-sunDir.x, 0, -sunDir.z).normalize();

  return (
    <Canvas
      shadows={shadows ? 'soft' : false}
      dpr={[1, 2]}
      className="argon-3d-view"
      camera={{ fov: ORBIT_FOV, near: 0.05, far: 500, position: [12, 10, 14] }}
      gl={{ antialias: true, preserveDrawingBuffer: true, toneMapping: THREE.ACESFilmicToneMapping, toneMappingExposure: 1.05 }}
      onCreated={({ gl, scene }) => {
        const sky = skyTexture();
        // The sky is the background — a horizon is worth far more to a render
        // that the eye reads as a photograph than a flat clear colour is — but
        // it is deliberately *not* `scene.environment`. See `materialFor`:
        // image-based lighting on every wall is an expensive way to produce a
        // difference nobody can see.
        scene.background = sky;
        gl.setClearColor('#f2efe7');
        // Fog pulled in much closer than it used to be. It started at fifty-two
        // metres, which is past the far edge of the plot, so nothing in the
        // scene was actually in it: the middle distance stayed at full
        // saturation and the first hint of haze arrived as an abrupt ramp at
        // the far edge of the lawn, which read as a milky green wash across
        // the top of the frame rather than as distance. Starting the ramp at
        // twenty-two puts it where the eye expects it — just past the house —
        // and gives the far ground somewhere to recede to.
        scene.fog = new THREE.Fog('#e9e4d6', 22, 118);
      }}
      data-testid="scene-3d"
    >
      {/* Sky and bounce. Deliberately weak: the previous 0.75 hemisphere plus
          0.25 ambient filled every shadow in, which is why the orbit view
          showed no cast shadow at all while the top view — looking straight
          down at the lawn — showed one perfectly clearly. Most of the ambient
          now comes from the environment map instead. */}
      <hemisphereLight args={['#dfe6ef', '#9aa08c', 0.28]} />
      <ambientLight intensity={0.1} />
      {/* The sun comes from over the street, swung to one side rather than dead
          on. A sun square to the elevation flattens it; raking across it gives
          the front face light and the return face shade, which is the difference
          between a wall and a wall that has a corner. Positioned from the
          compass bearing, so it follows the plot when the street edge moves. */}
      <directionalLight
        castShadow={shadows}
        position={[
          sunDir.x * shadowSpan * 2,
          sunDir.y * shadowSpan * 2,
          sunDir.z * shadowSpan * 2,
        ]}
        intensity={2.6}
        color="#fff2da"
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-shadowSpan}
        shadow-camera-right={shadowSpan}
        shadow-camera-top={shadowSpan}
        shadow-camera-bottom={-shadowSpan}
        // Tight to the scene. A 116 m depth range for a 20 m scene spent the
        // shadow map's precision on empty space, and the shortfall showed up as
        // evenly spaced vertical bands of wrong self-shadowing running across
        // the walls, the plinth and the ground alike.
        shadow-camera-near={shadowSpan * 0.7}
        shadow-camera-far={shadowSpan * 3.1}
        // Without these the wall boxes shadow-acne against their own floors,
        // which reads as dirt on the elevation rather than as a shadow.
        shadow-bias={-0.0006}
        shadow-normalBias={0.045}
        // Percentage-closer filtering with a wide kernel. A hard-edged shadow
        // from a directional light is the other half of the "not real" look:
        // the sun subtends half a degree and its edges are soft.
        shadow-radius={2.4}
      />
      {/* A dim, shadowless fill from the opposite side so the shaded elevation
          keeps some modelling instead of going flat and dead. */}
      <directionalLight position={[shadowDir.x * shadowSpan * 1.4, shadowSpan * 0.8, shadowDir.z * shadowSpan * 1.4]} intensity={0.55} color="#d9e3f2" />

      {/* Interior fill, indoors only.
          three.js has no global illumination. The sun is one directional light
          and a room's walls shadow it completely, so every surface *inside*
          the building is lit only by the hemisphere and the 0.1 ambient — and
          in practice the result was a room rendered nearly black, with the
          floor and the furniture in it invisible. That is not what a window
          does: the light that reaches the middle of a room has bounced off the
          lawn, the ceiling and the opposite wall first, and none of that is
          simulated here.

          Scoped to the inside camera on purpose. A global environment map
          would be the physically-honest fix and would also lift the exterior,
          but it costs an image-based-lighting lookup on every pixel — the most
          expensive thing in the frame, and this renders under a software
          rasteriser. A second hemisphere light is a handful of instructions
          per fragment, and it cannot change a single pixel in the three
          exterior modes that have already been checked. Cool from above
          (window light), warm from below (floor bounce). */}
      {cameraMode === 'inside' && (
        <hemisphereLight args={['#e9eff8', '#c2b6a2', 0.85]} />
      )}

      <Suspense fallback={null}>
        <Ground width={project.plot.width} depth={project.plot.depth} setbacks={project.plot.setbacks} />
        <Building boxes={geometry.boxes} onSelect={onSelect} />
        {cameraMode === 'walk' ? (
          <FirstPerson
            colliders={geometry.colliders}
            plot={{ width: project.plot.width, depth: project.plot.depth }}
            building={geometry.building}
            street={street}
            onExit={() => useProject.getState().setViewMode('3d')}
          />
        ) : cameraMode === 'inside' ? (
          <InsideView
            colliders={geometry.colliders}
            plot={{ width: project.plot.width, depth: project.plot.depth }}
            rooms={project.rooms}
            frame={frame}
            elevationOf={elevationOf}
            floorOrder={floorOrder}
            building={geometry.building}
            selectedRoomId={selectedRoomId}
            onInsideRoom={onInsideRoom}
          />
        ) : (
          <Rig mode={cameraMode} building={geometry.building} street={street} />
        )}
        <GizmoHelper alignment="bottom-right" margin={[72, 72]}>
          <GizmoViewport axisColors={['#c05b5b', '#5b9e6b', '#5b7cc0']} labelColor="#3f3a33" />
        </GizmoHelper>
      </Suspense>
    </Canvas>
  );
}

/** Fullscreen PNG of the current canvas, for the 3D export. */
export async function captureCanvas3D(el: HTMLElement | null): Promise<Blob | null> {
  if (!el) return null;
  const canvas = el.querySelector('canvas');
  if (!canvas) return null;
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}