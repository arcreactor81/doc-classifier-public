/**
 * Types for the small part of three.js (0.128, which ships no types of its own) that the Home picture uses
 * (components/sheets-scene.ts). Only what that file calls is declared.
 */
declare module 'three' {
  export const DoubleSide: number;

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    x: number; y: number; z: number;
    set(x: number, y: number, z: number): this;
    copy(v: Vector3): this;
    sub(v: Vector3): this;
    normalize(): this;
    project(camera: Camera): this;
    unproject(camera: Camera): this;
  }
  export class Euler {
    set(x: number, y: number, z: number): this;
  }
  export class Quaternion {
    setFromEuler(e: Euler): this;
    slerp(q: Quaternion, t: number): this;
    copy(q: Quaternion): this;
  }
  export class Matrix4 {}
  export class Color {
    constructor(hex?: number);
    copy(c: Color): this;
    lerp(c: Color, t: number): this;
  }

  export class Object3D {
    position: Vector3;
    rotation: Euler;
    quaternion: Quaternion;
    scale: Vector3;
    matrix: Matrix4;
    updateMatrix(): void;
    updateMatrixWorld(force?: boolean): void;
    add(...objects: Object3D[]): this;
  }
  export class Fog { constructor(color: number, near: number, far: number) }
  export class Scene extends Object3D { fog: Fog | null }
  export class Camera extends Object3D {
    lookAt(v: Vector3): void;
  }
  export class PerspectiveCamera extends Camera {
    constructor(fov: number, aspect: number, near: number, far: number);
    fov: number;
    aspect: number;
    updateProjectionMatrix(): void;
  }

  export class BufferGeometry { dispose(): void }
  export class PlaneGeometry extends BufferGeometry { constructor(w: number, h: number) }
  export class TorusGeometry extends BufferGeometry { constructor(r: number, tube: number, radial: number, tubular: number) }
  export class CircleGeometry extends BufferGeometry { constructor(r: number, segments: number) }

  export class Texture { dispose(): void }
  export class CanvasTexture extends Texture { constructor(canvas: HTMLCanvasElement) }

  export class Material {
    opacity: number;
    transparent: boolean;
    dispose(): void;
  }
  export interface MeshBasicMaterialParameters {
    color?: number; map?: Texture; side?: number; transparent?: boolean; opacity?: number; depthWrite?: boolean;
  }
  export class MeshBasicMaterial extends Material { constructor(parameters?: MeshBasicMaterialParameters) }

  export class Mesh extends Object3D {
    constructor(geometry: BufferGeometry, material: Material);
    geometry: BufferGeometry;
    material: Material;
  }
  export interface InstancedAttribute { needsUpdate: boolean }
  export class InstancedMesh extends Mesh {
    constructor(geometry: BufferGeometry, material: Material, count: number);
    instanceMatrix: InstancedAttribute;
    instanceColor: InstancedAttribute | null;
    setMatrixAt(index: number, matrix: Matrix4): void;
    setColorAt(index: number, color: Color): void;
  }
  export class GridHelper extends Object3D {
    constructor(size: number, divisions: number, color1: number, color2: number);
    geometry: BufferGeometry;
    material: Material;
  }

  export interface WebGLRendererParameters { canvas?: HTMLCanvasElement; antialias?: boolean; alpha?: boolean }
  export class WebGLRenderer {
    constructor(parameters?: WebGLRendererParameters);
    setPixelRatio(ratio: number): void;
    setClearColor(color: number, alpha: number): void;
    setSize(width: number, height: number, updateStyle?: boolean): void;
    setAnimationLoop(callback: ((time: number) => void) | null): void;
    render(scene: Scene, camera: Camera): void;
    dispose(): void;
    forceContextLoss(): void;
  }
}
