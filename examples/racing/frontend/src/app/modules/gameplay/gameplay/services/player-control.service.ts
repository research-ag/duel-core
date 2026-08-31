import { Mesh, PerspectiveCamera, Vector2 } from 'three';
import { asyncScheduler, combineLatest, Observable, Subscription } from 'rxjs';
import { VehiclePhysicsService } from '../../game-physics/services/vehicle-physics.service';
import { distinctUntilChanged, filter, map, throttleTime } from 'rxjs/operators';
import StepTrajectoryModel from '../../gameplay/models/gameplay/control/step-trajectory.model';
import { ControlSceneService } from '../../game-rendering/services/scenes/control-scene.service';
import { calculateSelectedTrajectory } from '../utils/calculate-selected-trajectory';
import { GameStateService } from '../../game-shared/services/game-state.service';
import { PlayerViewService } from './player-view.service';
import { ViewportService } from '../../game-viewport/services/viewport.service';

export class PlayerControlService {

  public trajectorySelected: Observable<StepTrajectoryModel | null> =
    this.viewportService.subscribeOnMouseClick()
      .pipe(
        filter(
          e => this.gameStateService.isInSelectionState.getValue() &&
            !!this.gameStateService.currentlySelectedTrajectory.getValue() &&
            this.gameStateService.controlsEnabled.getValue() &&
            !!this.playerViewService.camera.getValue()
        ),
        map(mousePosition => {
          const stepArcProperties = this.gameStateService.currentStepArcProperties.getValue();
          return stepArcProperties && calculateSelectedTrajectory(
            new Vector2(mousePosition.x, mousePosition.y),
            new Vector2(this.viewportService.getCurrentViewportSize().x, this.viewportService.getCurrentViewportSize().y),
            this.playerViewService.camera.getValue() as PerspectiveCamera,
            this.controlSceneService.controlPlane as Mesh,
            stepArcProperties,
          );
        }),
      );

  constructor(
    private readonly vehiclePhysicsService: VehiclePhysicsService,
    private readonly viewportService: ViewportService,
    private readonly gameStateService: GameStateService,
    private readonly controlSceneService: ControlSceneService,
    private readonly playerViewService: PlayerViewService,
  ) {
    combineLatest([
      this.viewportService.subscribeOnMouseMove(),
      this.viewportService.subscribeOnViewportSize(),
      this.playerViewService.camera.asObservable(),
      this.gameStateService.currentStepArcProperties.asObservable(),
      this.gameStateService.isInSelectionState.asObservable(),
    ])
      .pipe(
        filter(([ mousePosition, viewportSize, camera, stepArcProperties, isInSelectionState ]) => {
          return isInSelectionState && !!camera && !!this.controlSceneService.controlPlane && !!stepArcProperties;
        }),
        throttleTime(25, asyncScheduler, {
          leading: true,
          trailing: true
        }),
        map(([ mousePosition, viewportSize, camera, stepArcProperties ]) => {
          return stepArcProperties && calculateSelectedTrajectory(new Vector2(mousePosition.x, mousePosition.y), new Vector2(viewportSize.x, viewportSize.y), camera as PerspectiveCamera, this.controlSceneService.controlPlane as Mesh, stepArcProperties);
        }),
        distinctUntilChanged((traj1, traj2): boolean => {
          return traj1 ? traj1.equals(traj2) : !traj2;
        })
      )
      .subscribe(this.gameStateService.currentlySelectedTrajectory);
  }

  // used for moves forced to zero movement (crash penalty). Car is already stationary, so no click is required;
  // the arc is still shown (dimmed, via isSkippedStepWaiting) while we wait for other players.
  public submitSkippedMove(minDistance: number, maxDistance: number, momentumDistance: number,
                           maxSteeringCurvature: number): Promise<StepTrajectoryModel> {
    this.gameStateService.currentStepArcProperties.next({
      minDistance,
      maxDistance,
      maxSteeringCurvature,
      momentumDistance,
    });
    this.gameStateService.isSkippedStepWaiting.next(true);
    return Promise.resolve(new StepTrajectoryModel(0, 0));
  }

  // Waits for an actual click — no fallback auto-move on a timeout. A
  // player who does nothing just leaves their round unsubmitted; the
  // canister's own idle-takeover (see ../../../../../../CLAUDE.md) is
  // what eventually reclaims an abandoned game, same as every other
  // duel-game-core game. Don't reintroduce a client-side auto-submit
  // here — it let a player look like they'd moved when they hadn't.
  public askForSelectedPosition(minDistance: number, maxDistance: number, momentumDistance: number,
                                maxSteeringCurvature: number): Promise<StepTrajectoryModel> {
    return new Promise<StepTrajectoryModel>((resolve) => {
      this.gameStateService.currentStepArcProperties.next({
        minDistance,
        maxDistance,
        maxSteeringCurvature,
        momentumDistance,
      });
      this.gameStateService.isInSelectionState.next(true);
      const clickSubscription: Subscription = this.trajectorySelected
        .pipe(
          filter(x => !!x),
        )
        .subscribe((traj) => {
          clickSubscription.unsubscribe();
          this.gameStateService.isInSelectionState.next(false);
          resolve(traj as StepTrajectoryModel);
        });
    });
  }

}

