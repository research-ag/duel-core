import MapDataModel from '../../gameplay/models/gameplay/world/map-data.model';
import MapRoadSplineModel from '../../gameplay/models/gameplay/world/road-spline/map-road-spline.model';
import { ModelLoaderService } from './model-loader.service';
import MapPolygonModel from '../../gameplay/models/gameplay/world/map-polygon.model';
import { CubeReflectionMapping, CubeTexture, CubeTextureLoader, Scene, SRGBColorSpace, Vector2 } from 'three';
import CarPositioningModel from '../../gameplay/models/gameplay/world/car-positioning.model';
import { ShadowStrategy } from '../../game-rendering/enums/shadow-strategy.enum';
import { ResourcesConsts } from '../consts/resources.consts';


export class MapLoaderService {

  public POLYGON_NODE_REGEX: RegExp = /^map-polygon_(outer|inner)$/;

  public POSITION_NODE_REGEX: RegExp = /^player-position_(\d+)$/;

  public ROAD_PATH_NODE_REGEX: RegExp = /^road_path$/;

  public PROXY_OBJECT_REGEX: RegExp = /^proxy_([\w_]+)(\.\d+)?$/;

  private PROXIES_CACHE: Map<string, Scene> = new Map<string, Scene>();

  constructor(
    private readonly modelLoaderService: ModelLoaderService,
  ) {
  }

  async loadMap(mapName: string = 'island'): Promise<MapDataModel> {
    const [ scene, meta ] = await this.modelLoaderService.loadScene(`${ResourcesConsts.RES_PATH}maps/${mapName}/`, 'scene',
      ShadowStrategy.AS_DEFINED,
      ShadowStrategy.FORCE_SHADOW
    );
    const roadPath = meta.curves.find(curve => curve.name.match(this.ROAD_PATH_NODE_REGEX));
    const startPositions = meta.dummies
      .filter(dummy => dummy.name.match(this.POSITION_NODE_REGEX))
      .map(dummy => new CarPositioningModel(new Vector2(dummy.position.x, dummy.position.y), dummy.rotation.z, 0));
    const polygons = meta.curves.filter(curve => curve.name.match(this.POLYGON_NODE_REGEX));
    const mapPolygon: MapPolygonModel = new MapPolygonModel(
      polygons && polygons.find(polygon => polygon.name.endsWith('outer'))?.points || [],
      polygons && polygons.filter(polygon => polygon.name.endsWith('inner'))
        .map(curve => curve.points)
    );
    const proxyObjects = meta.dummies.filter(dummy => dummy.name.match(this.PROXY_OBJECT_REGEX));
    for (const proxyObject of proxyObjects) {
      const proxyId = this.PROXY_OBJECT_REGEX.exec(proxyObject.name)?.[1];
      if (!proxyId) {
        continue;
      }
      try {
        const proxy: any = await this.loadProxy(proxyId);
        proxy.position.set(proxyObject.position.x, proxyObject.position.y, proxyObject.position.z);
        proxy.rotation.set(proxyObject.rotation.x, proxyObject.rotation.y, proxyObject.rotation.z);
        const scale: number = Number(proxyObject.properties?.['scale'] ?? 1);
        proxy.scale.setScalar(scale);
        scene.add(proxy);
      } catch (err) {
        console.error(`Cannot load proxy object with id: "${proxyId}"`);
      }
    }
    const envMap: CubeTexture = new CubeTextureLoader()
      .setPath(`${ResourcesConsts.RES_PATH}maps/${mapName}/misc/skybox/`)
      .load([
        'nx.png', 'px.png',
        'py.png', 'ny.png',
        'pz.png', 'nz.png'
      ]);
    envMap.mapping = CubeReflectionMapping;
    envMap.colorSpace = SRGBColorSpace;
    const roadSpline = new MapRoadSplineModel(roadPath ? roadPath.points : []);
    return new MapDataModel(
      scene,
      envMap,
      mapPolygon,
      roadSpline,
      startPositions,
    );
  }

  async loadProxy(id: string): Promise<any> {
    const cached: any = this.PROXIES_CACHE.get(id);
    if (cached) {
      return cached.clone();
    }
    const [ scene, meta ] = await this.modelLoaderService.loadScene(
      `${ResourcesConsts.RES_PATH}proxies/`,
      id,
      ShadowStrategy.FORCE_SHADOW,
      ShadowStrategy.FORCE_SHADOW);
    this.PROXIES_CACHE.set(id, scene);
    return scene;
  }

}
