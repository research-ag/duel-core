import TrajectoryDisplayObject from '../../display-objects/3d/controls/trajectory.display-object';
import StepArcDisplayObject from '../../display-objects/3d/controls/step-arc.display-object';
import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, SphereGeometry, Vector2 } from 'three';
import { combineLatest, Observable, of } from 'rxjs';
import { distinctUntilChanged, filter, flatMap, map } from 'rxjs/operators';
import { RenderingConsts } from '../../../gameplay/consts/rendering.consts';
import { GameStateService } from '../../../game-shared/services/game-state.service';
import { PlayerViewService } from '../../../gameplay/services/player-view.service';
import { ThreeScene } from '../../../game-viewport/entities/three-scene';
import { DisplayService } from '../../../game-viewport/services/display.service';

export class ControlSceneService {

  // fixed step-control color - no longer a player-configurable setting.
  private static readonly STEP_CONTROL_COLOR: string = '#427df4';

  private scene: ThreeScene | undefined;

  private controlPlaneContainer: Group | undefined;
  // invisible service plane below the car, used for calculating trajectory from mouse position
  public controlPlane: Mesh | undefined;
  // sphere, indicating nest step position
  private controlSphere: Mesh | undefined;
  // next step trajectory indication
  private controlTrajectoryHelper: TrajectoryDisplayObject | undefined;
  // next step area of possible positions indication
  private controlAreaHelper: StepArcDisplayObject | undefined;

  constructor(
    protected readonly playerViewService: PlayerViewService,
    private readonly gameStateService: GameStateService,
    private readonly display: DisplayService,
  ) {
  }

  public async init(): Promise<void> {
    this.scene = await this.display.addThreeJsCanvas(0, {
      transparent: true,
    });
    this.playerViewService.camera.subscribe(this.scene.camera$);
    combineLatest([
      this.gameStateService.currentlySelectedTrajectory,
      this.gameStateService.isInSelectionState,
    ])
      .pipe(
        distinctUntilChanged(([ tr1, s1 ], [ tr2, s2 ]) => {
          return s1 === s2 && tr1 ? tr1.equals(tr2) : !tr2;
        }),
        map(([ trajectory, isInSelectionMode ]) => {
          if (this.controlSphere && this.controlTrajectoryHelper) {
            if (trajectory && isInSelectionMode) {
              this.controlSphere.position.set(trajectory.position.x, trajectory.position.y, 0);
              this.controlSphere.visible = true;
              this.controlTrajectoryHelper.visible = true;
              this.controlTrajectoryHelper.setTrajectory(trajectory);
            } else {
              this.controlSphere.visible = false;
              this.controlTrajectoryHelper.visible = false;
            }
          }
        })
      )
      .subscribe(() => this.scene?.renderOnce());
    combineLatest([
      this.gameStateService.currentStepArcProperties,
      this.gameStateService.isInSelectionState,
      this.gameStateService.isSkippedStepWaiting,
      this.gameStateService.isInAnimationState,
    ])
      .pipe(
        distinctUntilChanged(([ props1, s1, w1, a1 ], [ props2, s2, w2, a2 ]) => {
          // in most cases props are changing, so nevermind.
          // If doesn't work, please check that props are populated BEFORE setting selection/skipped state
          return s1 === s2 && w1 === w2 && a1 === a2;
        }),
        map(([ props, isInSelectionMode, isSkippedStepWaiting, isInAnimationState ]) => {
          if (this.controlAreaHelper) {
            // never show the arc while a move is animating - only during actual selection/waiting
            if (props && !isInAnimationState && (isInSelectionMode || isSkippedStepWaiting)) {
              this.controlAreaHelper.setAreaProperties(
                props.minDistance, props.maxDistance,
                props.momentumDistance, props.maxSteeringCurvature
              );
              this.controlAreaHelper.visible = true;
              this.controlAreaHelper.setSkipped(isSkippedStepWaiting);
            } else {
              this.controlAreaHelper.visible = false;
            }
          }
        })
      )
      .subscribe(() => this.scene?.renderOnce());
    this.playerViewService.subscribeOnCameraDistance()
      .pipe(
        map((cameraDistance: number) => {
          if (this.controlSphere && this.controlTrajectoryHelper && this.controlAreaHelper) {
            const areaToShow: number = cameraDistance * Math.tan(RenderingConsts.FIELD_OF_VIEW * Math.PI / 360);
            this.controlSphere.scale.set(areaToShow / 50, areaToShow / 50, areaToShow / 50);
            this.controlTrajectoryHelper.thickness = areaToShow / 125;
            this.controlAreaHelper.strokeThickness = areaToShow / 125;
            this.controlAreaHelper.innerThickness = areaToShow / 300;
          }
        })
      )
      .subscribe(() => this.scene?.renderOnce());
    combineLatest([
      this.gameStateService.trackingCar,
      this.gameStateService.isInSelectionState,
    ])
      .pipe(
        filter(([ car, isInSelectionState ]) => {
          return !car || !isInSelectionState;
        }),
        flatMap(([ car ]): Observable<[ Vector2, number ]> => {
            if (car) {
              return combineLatest([
                car.positionChangedSubject,
                car.rotationChangedSubject,
              ]);
            } else {
              return of([ new Vector2(), 0 ]);
            }
          }
        ),
      )
      .subscribe(([ position, rotation ]) => {
        if (this.controlPlaneContainer) {
          this.controlPlaneContainer.position.set(position.x, position.y, 0);
          this.controlPlaneContainer.rotation.set(0, 0, rotation);
        }
      });
    this.playerViewService.subscribeOnCameraPosition()
      .subscribe(() => this.scene?.renderOnce());
    this.controlPlaneContainer = new Group();
    this.controlPlane = new Mesh(
      new PlaneGeometry(1000, 1000, 1, 1),
      new MeshBasicMaterial({
        opacity: 0,
        transparent: true,
        depthWrite: false
      })
    );
    this.controlSphere = new Mesh(
      new SphereGeometry(1),
      new MeshBasicMaterial({ color: 0 })
    );
    this.controlTrajectoryHelper = new TrajectoryDisplayObject();
    this.controlAreaHelper = new StepArcDisplayObject();
    this.controlPlaneContainer.add(this.controlPlane, this.controlSphere, this.controlTrajectoryHelper, this.controlAreaHelper);
    this.scene.scene.add(this.controlPlaneContainer);
    // @ts-ignore
    this.controlSphere.material['color'].set(ControlSceneService.STEP_CONTROL_COLOR);
    // @ts-ignore
    this.controlTrajectoryHelper.material['color'].set(ControlSceneService.STEP_CONTROL_COLOR);
    this.controlAreaHelper.setColor(ControlSceneService.STEP_CONTROL_COLOR);
  }

}
