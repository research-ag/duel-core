import { CubeTexture, DirectionalLight, HemisphereLight, Mesh, Scene, Vector3 } from 'three';
import { GameStateService } from '../../../game-shared/services/game-state.service';
import Car from '../../../gameplay/models/gameplay/entities/car.model';
import { CarLoaderService } from '../../../game-resources/services/car-loader.service';
import CarPositioningModel from '../../../gameplay/models/gameplay/world/car-positioning.model';
import ThreeSceneLayerEnum from '../../../gameplay/models/enums/three-scene-layer.enum';
import { RenderingConsts } from '../../../gameplay/consts/rendering.consts';
import MapDataModel from '../../../gameplay/models/gameplay/world/map-data.model';
import { PlayerViewService } from '../../../gameplay/services/player-view.service';
import SeaShaderMesh from '../../../game-resources/shaders/sea.shader-mesh';
import { filter, map } from 'rxjs/operators';
import { GeomUtils } from '../../../../../../utils/geom.utils';
import { DisplayService } from '../../../game-viewport/services/display.service';
import { ThreeScene } from '../../../game-viewport/entities/three-scene';
import { Observable } from 'rxjs';

export class WorldSceneService {

  // fixed graphics settings - no longer player-configurable.
  private static readonly SHADOW_RESOLUTION: number = 2048;
  private static readonly TEXTURE_FILTERING: number = 4;

  private mapScene: Scene | null = null;
  private readonly carMeshes: Mesh[];
  private sunDirectLight: DirectionalLight | undefined;
  private envMap: CubeTexture | undefined;

  private scene: ThreeScene | undefined;

  constructor(
    protected readonly playerViewService: PlayerViewService,
    private readonly gameStateService: GameStateService,
    private readonly carLoaderService: CarLoaderService,
    private readonly display: DisplayService,
  ) {
    this.carMeshes = [];
  }

  public async init(): Promise<void> {
    this.scene = await this.display.addThreeJsCanvas(-1);
    const scene = this.scene as ThreeScene;

    const sunAmbientLight: HemisphereLight = new HemisphereLight(0xbbbbff, 0x8890a0, 4);
    sunAmbientLight.position.set(0, 0, 1);
    sunAmbientLight.layers.enable(ThreeSceneLayerEnum.SeaReflectionLayer);
    this.scene?.scene.add(sunAmbientLight);
    this.sunDirectLight = new DirectionalLight(0xffffaa, 10);
    this.sunDirectLight.layers.enable(ThreeSceneLayerEnum.SeaReflectionLayer);
    this.scene?.scene.add(this.sunDirectLight);
    this.scene?.scene.add(this.sunDirectLight.target);

    this.playerViewService.camera.subscribe(scene.camera$);
    this.gameStateService.isInAnimationState.subscribe(scene.renderLoopEnabled$);
    this.gameStateService.mapData
      .pipe(filter(mapData => !!mapData), map(mapData => mapData as MapDataModel))
      .subscribe((mapData: MapDataModel) => {
        const needToRender: boolean = !!this.mapScene || !!mapData;
        if (this.mapScene) {
          scene.scene.remove(this.mapScene);
          this.mapScene = null;
        }
        if (mapData) {
          this.mapScene = mapData.scene;
          scene.scene.add(this.mapScene);
        }
        this.envMap = mapData.envMap;
        scene.scene.background = this.envMap;
        this.applyEnvMap(scene.scene, this.envMap);
        if (needToRender) {
          scene.renderOnce();
        }
      });
    this.gameStateService.cars
      .pipe(filter(cars => !!cars), map(cars => cars as Car[]))
      .subscribe(async (cars: Car[]) => {
        for (let i = 0; i < cars.length; i++) {
          if (!cars[i]) {
            if (this.carMeshes[i]) {
              // @ts-ignore
              if (this.carMeshes[i]['dispose']) {
                // @ts-ignore
                this.carMeshes[i]['dispose']();
              }
              // @ts-ignore
              this.carMeshes[i] = null;
            }
            continue;
          }
          if (!this.carMeshes[i]) {
            // for not creating twice if called before asynchronously loaded
            this.carMeshes[i] = new Mesh();
            this.carMeshes[i] = await this.carLoaderService.loadCar(cars[i].model);
            if (this.envMap) {
              this.applyEnvMap(this.carMeshes[i], this.envMap);
            }
            scene.scene.add(this.carMeshes[i]);
            scene.renderOnce();
          }
        }
      });
    this.playerViewService.subscribeOnCameraPosition()
      .subscribe(() => {
        this.scene?.renderOnce();
      });
    // fixed graphics settings applied once - there is no settings UI to
    // change them at runtime anymore.
    if (this.sunDirectLight) {
      const shadowResolution: number = WorldSceneService.SHADOW_RESOLUTION;
      this.sunDirectLight.castShadow = shadowResolution > 0;
      if (shadowResolution > 0) {
        this.sunDirectLight.shadow.mapSize.width = shadowResolution;
        this.sunDirectLight.shadow.mapSize.height = shadowResolution;
      }
    }
    const anisotropy: number = this.scene.renderer
      ? Math.min(WorldSceneService.TEXTURE_FILTERING, this.scene.renderer.capabilities.getMaxAnisotropy())
      : WorldSceneService.TEXTURE_FILTERING;
    this.scene.scene.traverse((node) => {
      if (node instanceof Mesh) {
        if (node.material && node.material['map'] && node.material['map'].anisotropy != anisotropy) {
          node.material['map'].anisotropy = anisotropy;
          node.material['map'].needsUpdate = true;
        }
      }
    });
    this.scene.subscribeOnUpdateScene().subscribe(() => {
      const cars: Car[] = this.gameStateService.cars.getValue() || [];
      for (let i = 0; i < cars.length; i++) {
        if (!cars[i] || !this.carMeshes[i]) {
          continue;
        }
        const positioning: CarPositioningModel = cars[i].getFullPositioning();
        this.carMeshes[i].position.set(positioning.position.x, positioning.position.y, 0);
        this.carMeshes[i].rotation.z = positioning.rotation;
      }
      const cameraTargetPosition: Vector3 = this.playerViewService.currentCameraTargetPosition;
      const cameraPosition: Vector3 = this.playerViewService.currentCameraPosition;
      const lightPositionVector: Vector3 = new Vector3(
        cameraTargetPosition.x + 500 * Math.cos(RenderingConsts.sunLightTheta) * Math.sin(RenderingConsts.sunLightPhi),
        cameraTargetPosition.y + 500 * Math.sin(RenderingConsts.sunLightTheta) * Math.sin(RenderingConsts.sunLightPhi),
        500 * Math.cos(RenderingConsts.sunLightPhi)
      );
      const lightTargetVector: Vector3 = cameraTargetPosition.clone();
      // camera is always the static top-down/chase view, so the light
      // frustum is always sized from the camera-to-target distance.
      let d: number = (
        cameraPosition.distanceTo(cameraTargetPosition) * Math.tan(RenderingConsts.FIELD_OF_VIEW * Math.PI / 180)
      ) * Math.sin(Math.PI / 2 - RenderingConsts.sunLightPhi);
      const discretizedLightPositionVector: Vector3 = GeomUtils.discretizePoint(lightPositionVector);
      const diffVector = new Vector3();
      diffVector.subVectors(discretizedLightPositionVector, lightPositionVector);
      lightTargetVector.add(diffVector);
      if (this.sunDirectLight) {
        this.sunDirectLight.position.set(discretizedLightPositionVector.x, discretizedLightPositionVector.y, discretizedLightPositionVector.z);
        this.sunDirectLight.target.position.set(lightTargetVector.x, lightTargetVector.y, lightTargetVector.z);
        // * by square root of three for filling all screen corners (if screen is square)
        d *= Math.sqrt(3);
        // safe increment
        d += 10;
        this.sunDirectLight.shadow.camera.bottom = -d;
        this.sunDirectLight.shadow.camera.top = d;
        this.sunDirectLight.shadow.camera.left = -d;
        this.sunDirectLight.shadow.camera.right = d;
        this.sunDirectLight.shadow.camera.near = 200;
        this.sunDirectLight.shadow.camera.far = 800;
        if (this.sunDirectLight.shadow?.map) {
          // @ts-ignore
          if (this.sunDirectLight.shadow.map['dispose']) {
            // @ts-ignore
            this.sunDirectLight.shadow.map['dispose']();
          }
          // @ts-ignore
          this.sunDirectLight.shadow.map = null;
        }
      }
      this.scene?.scene.traverse((node) => {
        // FIXME instanceof BaseShaderMesh!!!
        if (node instanceof SeaShaderMesh) {
          node.updateShader(this.gameStateService.raceTime);
        }
      });
    });
  }

  public subscribeOnBeforeRendering(): Observable<void> {
    return this.scene?.subscribeOnBeforeRendering() as Observable<void>;
  }

  private applyEnvMap(scene: any, envMap: CubeTexture): void {
    scene.traverse((node: any) => {
      if (node instanceof Mesh && node.material && !node.userData.unlit) {
        // @ts-ignore
        (node as Mesh).material['envMap'] = envMap;
        // @ts-ignore
        (node as Mesh).material['envMapIntensity'] = 0.5;
      }
    });
  }

}
