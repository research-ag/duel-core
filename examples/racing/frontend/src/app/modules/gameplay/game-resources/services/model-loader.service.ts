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

  constructor(
    private readonly shaderLoaderService: ShaderLoaderService,
  ) {
  }

  async loadScene(path: string, filename: string,
                  shadowCastStrategy: ShadowStrategy = ShadowStrategy.AS_DEFINED,
                  shadowReceiveStrategy: ShadowStrategy = ShadowStrategy.AS_DEFINED,
  ) {
    return Promise.all([
      this.loadGlb(`${path}${filename}.glb`, shadowCastStrategy, shadowReceiveStrategy),
      this.loadMeta(`${path}${filename}.meta`)
    ]);
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
      });
    });
  }


  private async loadMeta(path: string): Promise<Meta> {
    const meta: Meta = await fetch(path).then(r => r.json());
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
