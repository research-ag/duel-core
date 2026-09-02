import { Mesh, MeshBasicMaterial, Object3D, Scene, SRGBColorSpace, Vector3 } from 'three';
import ThreeSceneLayerEnum from '../../gameplay/models/enums/three-scene-layer.enum';
import { ShaderLoaderService } from './shader-loader.service';
import { ShadowStrategy } from '../../game-rendering/enums/shadow-strategy.enum';
import { GLTFLoader, GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

type Meta = {
  curves: { name: string, points: Vector3[] }[],
  dummies: { name: string, position: Vector3, rotation: Vector3, properties: Record<string, number | string | boolean> }[],
};

export class ModelLoaderService {

  // Assets (maps/cars/proxies) are served off an asset canister, which
  // can return a transient 502/503 (boot-storm, subnet hiccup, ...) the
  // same way any other HTTP endpoint can — a couple of retries clears
  // most of those without bothering the player. If it's still failing
  // after this many attempts, treat it as a real, non-transient failure
  // rather than retrying forever: callers loading something essential
  // (map-loader.service.ts's loadMap()) forfeit the race instead of
  // leaving the player stuck on an infinite spinner.
  private static readonly LOAD_ATTEMPTS = 3;
  private static readonly LOAD_RETRY_DELAY_MS = 1000;

  constructor(
    private readonly shaderLoaderService: ShaderLoaderService,
  ) {
  }

  async loadScene(path: string, filename: string,
                  shadowCastStrategy: ShadowStrategy = ShadowStrategy.AS_DEFINED,
                  shadowReceiveStrategy: ShadowStrategy = ShadowStrategy.AS_DEFINED,
  ) {
    return this.withRetries(() => Promise.all([
      this.loadGlb(`${path}${filename}.glb`, shadowCastStrategy, shadowReceiveStrategy),
      this.loadMeta(`${path}${filename}.meta`)
    ]), `${path}${filename}`);
  }

  // Retries `attempt` as a whole (both the .glb and its .meta sidecar)
  // rather than trying to retry each half independently — simpler, and a
  // failure on either one means the pair isn't usable yet anyway.
  private async withRetries<T>(attempt: () => Promise<T>, label: string): Promise<T> {
    let lastErr: unknown;
    for (let i = 1; i <= ModelLoaderService.LOAD_ATTEMPTS; i++) {
      try {
        return await attempt();
      } catch (err) {
        lastErr = err;
        console.warn(`duel: failed to load "${label}" (attempt ${i}/${ModelLoaderService.LOAD_ATTEMPTS})`, err);
        if (i < ModelLoaderService.LOAD_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, ModelLoaderService.LOAD_RETRY_DELAY_MS));
        }
      }
    }
    throw lastErr;
  }

  private async loadGlb(path: string,
                        shadowCastStrategy: ShadowStrategy = ShadowStrategy.AS_DEFINED,
                        shadowReceiveStrategy: ShadowStrategy = ShadowStrategy.AS_DEFINED,
  ): Promise<Scene> {
    return new Promise<any>((resolve, reject) => {
      const loader: GLTFLoader = new GLTFLoader();
      const meshesToReplaceWithShader: Mesh[] = [];
      loader.load(path, (gltf: GLTF) => {
        gltf.scene.traverse((node: Object3D) => {
          const userData: any = {};
          const dataContainers = [ node ];
          let n: any = node;
          while (n.parent && !(n.parent instanceof Scene)) {
            dataContainers.unshift(n.parent);
            n = n.parent;
          }
          for (n of dataContainers) {
            Object.assign(userData, n.userData);
          }
          node.castShadow = shadowCastStrategy !== ShadowStrategy.NO_SHADOW && (
            shadowCastStrategy === ShadowStrategy.FORCE_SHADOW ||
            !!userData.cast_shadow
          );
          node.receiveShadow = shadowReceiveStrategy !== ShadowStrategy.NO_SHADOW && (
            shadowReceiveStrategy === ShadowStrategy.FORCE_SHADOW ||
            !!userData.cast_shadow
          );
          if (node instanceof Mesh) {
            if (userData.reflect_by_sea) {
              node.layers.set(ThreeSceneLayerEnum.SeaReflectionLayer);
            }
            if (userData.unlit) {
              node.material = new MeshBasicMaterial({ map: node.material['map'] });
            }
            if (userData.use_shader) {
              meshesToReplaceWithShader.push(node);
            }
            if (node.material && node.material['map']) {
              node.material['map'].colorSpace = SRGBColorSpace;
              node.material['map'].needsUpdate = true;
            }
            node.material.wrapAround = true;
            node.material.needsUpdate = true;
          }
        });
        meshesToReplaceWithShader.forEach((node) => {
          const parent = node.parent;
          if (parent) {
            parent.remove(node);
            parent.add(this.shaderLoaderService.attachShader(node, node.userData.use_shader));
          }
        });
        resolve(gltf.scene);
      }, undefined, (err) => reject(err));
    });
  }


  private async loadMeta(path: string): Promise<Meta> {
    const response = await fetch(path);
    if (!response.ok) {
      throw new Error(`Failed to load "${path}": ${response.status} ${response.statusText}`);
    }
    const meta: Meta = await response.json();
    meta.curves.forEach(curve => {
      curve.points = curve.points.map(point => new Vector3(point.x, point.y, point.z));
    });
    meta.dummies.forEach(dummy => {
      dummy.position = new Vector3(dummy.position.x, dummy.position.y, dummy.position.z);
      dummy.rotation = new Vector3(dummy.rotation.x, dummy.rotation.y, dummy.rotation.z);
    });
    return meta;
  }

}
