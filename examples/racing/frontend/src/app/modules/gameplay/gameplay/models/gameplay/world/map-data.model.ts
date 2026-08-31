import MapPolygonModel from './map-polygon.model';
import MapRoadSplineModel from './road-spline/map-road-spline.model';
import CarPositioningModel from './car-positioning.model';
import { CubeTexture, Scene } from 'three';

export default class MapDataModel {

  constructor(
    public scene: Scene,
    public envMap: CubeTexture,
    public polygon: MapPolygonModel,
    public roadSpline: MapRoadSplineModel,
    public startPositions: CarPositioningModel[],
  ) {
  }
}
