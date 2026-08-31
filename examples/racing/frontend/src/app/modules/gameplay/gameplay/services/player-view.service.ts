import { BehaviorSubject, combineLatest, Observable, of } from 'rxjs';
import { PerspectiveCamera, Vector2, Vector3 } from 'three';
import { distinctUntilChanged, filter, flatMap, map } from 'rxjs/operators';
import { VehiclePhysicsService } from '../../game-physics/services/vehicle-physics.service';
import Car from '../../gameplay/models/gameplay/entities/car.model';
import { GameStateService } from '../../game-shared/services/game-state.service';
import ThreeSceneLayerEnum from '../../gameplay/models/enums/three-scene-layer.enum';
import { RenderingConsts } from '../consts/rendering.consts';
import { CinematicUtils } from '../../../../../utils/cinematic.utils';
import { ViewportService } from '../../game-viewport/services/viewport.service';

export class PlayerViewService {

  public camera: BehaviorSubject<PerspectiveCamera | null> = new BehaviorSubject<PerspectiveCamera | null>(null);
  private cameraPosition: BehaviorSubject<[ Vector3, Vector3, number ]> = new BehaviorSubject<[ Vector3, Vector3, number ]>([ new Vector3(0, 0, 64),
    new Vector3(0, 0, 0), 0
  ]);

  constructor(
    private readonly gameStateService: GameStateService,
    private readonly vehiclePhysicsService: VehiclePhysicsService,
    private readonly viewportService: ViewportService,
  ) {
    const camera: PerspectiveCamera = new PerspectiveCamera(
      RenderingConsts.FIELD_OF_VIEW,
      1,
      RenderingConsts.CAMERA_NEAR_CLIPPING_PANE,
      RenderingConsts.CAMERA_FAR_CLIPPING_PANE,
    );
    camera.layers.enable(ThreeSceneLayerEnum.SeaReflectionLayer);
    this.camera.next(camera);
    this.gameStateService.trackingCar
      .pipe(
        filter(car => !!car),
        map(car => car as Car), // so linter would be happy
        flatMap((car: Car) => {
          return combineLatest([
            of(car),
            car.positionChangedSubject.asObservable(),
            car.rotationChangedSubject.asObservable(),
            car.speedChangedSubject.asObservable(),
          ]);
        }),
        map(([ car, carPosition, carRotation, carSpeed ]) => {
          return this.calculateCameraPosition(car, carPosition, carRotation, carSpeed);
        }),
        distinctUntilChanged((v1: [ Vector3, Vector3, number ], v2: [ Vector3, Vector3, number ]) => {
          return v1[0].equals(v2[0]) && v1[1].equals(v2[1]) && v1[2] == v2[2];
        })
      )
      .subscribe(this.cameraPosition);
    combineLatest([
      this.subscribeOnCameraPosition(),
      this.camera.asObservable(),
    ])
      .pipe(
        filter(([ cameraPosition, camera ]) => {
          return !!camera;
        })
      )
      .subscribe(([ [ cameraPosition, cameraTargetPosition, cameraRotation ], camera ]) => {
        if (camera) {
          camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);
          camera.up = new Vector3(Math.cos(cameraRotation), Math.sin(cameraRotation), 0);
          camera.lookAt(cameraTargetPosition);
        }
      });
  }

  get currentCameraPosition(): Vector3 {
    return this.cameraPosition.getValue()[0];
  }

  get currentCameraTargetPosition(): Vector3 {
    return this.cameraPosition.getValue()[1];
  }

  subscribeOnCameraDistance(): Observable<number> {
    return this.cameraPosition
      .asObservable()
      .pipe(
        map(([ position, targetPosition, rotation ]) => {
          return position.distanceTo(targetPosition);
        }),
        distinctUntilChanged(),
      );
  }

  subscribeOnCameraPosition(): Observable<[ Vector3, Vector3, number ]> {
    return this.cameraPosition
      .asObservable();
  }

  // camera is always the static top-down/chase view; there is no
  // camera-mode switch — don't add one without being asked.
  private calculateCameraPosition(car: Car, carPosition: Vector2, carRotation: number, carSpeed: number): [ Vector3, Vector3, number ] {
    const position: Vector3 = new Vector3(
      carPosition.x + Math.cos(carRotation) * Math.max(carSpeed, 0) / 2,
      carPosition.y + Math.sin(carRotation) * Math.max(carSpeed, 0) / 2,
      Math.max(
        CinematicUtils.getDistanceInUniformlyAcceleratedMotion(
          0,
          this.vehiclePhysicsService.getMaxAcceleration(car.characteristics, 0),
          1
        ) / Math.tan(RenderingConsts.FIELD_OF_VIEW * Math.PI / 630),
        (
          CinematicUtils.getDistanceInUniformlyAcceleratedMotion(
            Math.max(carSpeed, 0),
            this.vehiclePhysicsService.getMaxAcceleration(car.characteristics, Math.max(carSpeed, 0)),
            1
          )
        ) / Math.tan(RenderingConsts.FIELD_OF_VIEW * Math.PI / 360)
      )
    );
    const targetPosition: Vector3 = new Vector3(
      position.x,
      position.y,
      0,
    );
    return [ position, targetPosition, Math.PI / 2 ];
  }

}
