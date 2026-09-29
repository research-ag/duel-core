import { Subscription } from 'rxjs';
import { Vector2, Vector3 } from 'three';
import MapDataModel from '../models/gameplay/world/map-data.model';
import CarPositionOnRoadSplineModel from '../models/gameplay/world/road-spline/car-position-on-road-spline.model';
import StepTrajectoryModel from '../models/gameplay/control/step-trajectory.model';
import CarGamePlayPositionModel from '../models/gameplay/helpers/car-game-play-position.model';
import CarPositioningModel from '../models/gameplay/world/car-positioning.model';
import Car from '../models/gameplay/entities/car.model';
import CarLapProgressModel from '../models/gameplay/helpers/car-lap-progress.model';
import StepDataModel from '../models/gameplay/control/step-data.model';
import { LobbyConnectionService } from '../../game-communication/services/lobby-connection.service';
import { Move } from '../models/gameplay/control/move.type';
import { GamePhysicsService } from '../../game-physics/services/game-physics.service';
import { MapLoaderService } from '../../game-resources/services/map-loader.service';
import { CarLoaderService } from '../../game-resources/services/car-loader.service';
import { WorldSceneService } from '../../game-rendering/services/scenes/world-scene.service';
import { GameStateService } from '../../game-shared/services/game-state.service';
import { PlayerControlService } from './player-control.service';
import { PolarPoint } from '../../../../../utils/models/polar-point.model';
import { CinematicUtils } from '../../../../../utils/cinematic.utils';
import { ControlSceneService } from '../../game-rendering/services/scenes/control-scene.service';

// Must match RacingRules.mo's LAPS_TO_WIN; the canister's resolve() is
// authoritative, this only detects a finish client-side.
const LAPS_TO_WIN = 1;
// The first step crosses the wrap point for free, so finishing takes
// LAPS_TO_WIN + 1 crossings (see RacingRules.mo's `resolve`).
const FINISH_LAP_COUNT = LAPS_TO_WIN + 1;

export class GameplayService {

  isWaitingPlayers: boolean = false;

  private mapData: MapDataModel | undefined;
  private stepsCount: number = 0;
  // The first step after (re)starting is a snap, never an animation.
  private isFirstStepSinceStart: boolean = true;
  // My move for the current round was already locked in when a reload
  // landed here; skip asking for a second one.
  private awaitingOwnSubmissionFromBeforeReload: boolean = false;
  // whether the most recently requested move was a forced skip
  private lastRequestedMoveWasSkip: boolean = false;
  private lastCarPositionsOnRoadSpline: Map<number, { calculatedAt: number, speed: number, pos: CarPositionOnRoadSplineModel, progress: CarLapProgressModel, lap: number }> = new Map<number, { calculatedAt: number; speed: number; pos: CarPositionOnRoadSplineModel; progress: CarLapProgressModel; lap: number }>();
  private raceResults: any;
  // Retries of the CURRENT round's submit; reset on every new round.
  private moveRetryCount: number = 0;
  private static readonly MAX_MOVE_RETRIES = 5;
  private static readonly MOVE_RETRY_BASE_BACKOFF_MS = 500;
  // Scene setup is not idempotent; only loadMap() retries after a failure.
  private sceneReady: boolean = false;
  private activeAnimationSub: Subscription | null = null;

  constructor(
    private readonly gameStateService: GameStateService,
    private readonly lobbyConnectionService: LobbyConnectionService,
    private readonly mapLoaderService: MapLoaderService,
    private readonly carLoaderService: CarLoaderService,
    private readonly gamePhysicsService: GamePhysicsService,
    private readonly playerControlService: PlayerControlService,
    private readonly worldSceneService: WorldSceneService,
    private readonly controlSceneService: ControlSceneService,
  ) {
  }

  private get raceTimestamp(): number {
    return this.stepsCount;
  }

  // Page-lifetime setup; resetForNewRace() handles per-race state.
  async init(): Promise<void> {
    if (!this.sceneReady) {
      await Promise.all([this.worldSceneService.init(), this.controlSceneService.init()]);
      this.sceneReady = true;
    }
    //TODO: get map name from lobby item
    try {
      this.mapData = await this.mapLoaderService.loadMap();
    } catch (err) {
      // Already retried by model-loader.service.ts; forfeit rather than leave
      // both players on a permanent loading screen.
      console.error('duel: could not load the track — forfeiting this race', err);
      await this.lobbyConnectionService.forfeit();
      throw err;
    }
    this.gameStateService.mapData.next(this.mapData);
    this.lobbyConnectionService.lobbyData
      .subscribe(this.gameStateService.runtimeData);
    // TODO fix serialization here. Use class transformer
    this.lobbyConnectionService.nextStep
      .subscribe(
        ({ steps, isFinal }) => this.onStepComplete(
          steps.map((item: { slot: number, step: StepDataModel }): { slot: number, step: StepDataModel } => {
            if (item.step.trajectory) {
              item.step.trajectory = new StepTrajectoryModel(item.step.trajectory.l, item.step.trajectory.c);
            }
            return item;
          }),
          isFinal,
        )
      );
  }

  // Once per race, rematches included, and on a reload landing mid-race.
  // `resumedAtStep` seeds the clock from the canister's true round;
  // `youAlreadySubmitted` skips re-asking for a move already locked in.
  startRace(resumedAtStep: number = 0, youAlreadySubmitted: boolean = false) {
    this.cancelActiveAnimation();
    this.playerControlService.cancelPendingSelection();
    this.isWaitingPlayers = true;
    this.stepsCount = resumedAtStep;
    this.isFirstStepSinceStart = true;
    this.awaitingOwnSubmissionFromBeforeReload = youAlreadySubmitted;
    this.lastRequestedMoveWasSkip = false;
    this.lastCarPositionsOnRoadSpline = new Map();
    this.gameStateService.skippedMovesRemaining.next(0);
    this.gameStateService.isSkippedStepWaiting.next(false);
    this.gameStateService.isInSelectionState.next(false);
    this.gameStateService.isInAnimationState.next(false);
    this.gameStateService.currentlySelectedTrajectory.next(null);
    this.gameStateService.currentStepArcProperties.next(null);
    this.gameStateService.playerPositions.next(null);
    this.gameStateService.resetRaceClock(resumedAtStep);
    this.lobbyConnectionService.emitLoadingStateChanged(false)
      .subscribe();
  }

  // `isFinal`: animate this step, then hand back to the debrief chrome.
  async onStepComplete(data: { slot: number, step: StepDataModel }[], isFinal: boolean = false): Promise<void> {
    // reset before playAnimations() so the dimmed skip-arc never lingers
    this.gameStateService.isSkippedStepWaiting.next(false);
    // TODO switch to use array like this everywhere
    const steps: { positioning: CarPositioningModel, move: Move }[] = [];
    for (const entry of data) {
      // read before playAnimations() mutates the car to its final position
      const startPositioning: CarPositioningModel = (this.gameStateService.cars.getValue() || [])[entry.slot].getFullPositioning();
      if (entry.slot === this.gameStateService.mySlot.getValue()) {
        // The canister's own crashPenaltyRemaining is authoritative; a local
        // collision re-check could disagree and soft-lock the arc.
        this.gameStateService.skippedMovesRemaining.next(entry.step.crashPenaltyRemaining);
      } else if (entry.step.crashed && entry.step.trajectory) {
        // The opponent's real trajectory is hidden; the chord fit through a
        // clamped crash position can be implausible, so probe forward at max
        // distance and let our own collision search freeze at the wall.
        const opponentCar: Car = (this.gameStateService.cars.getValue() || [])[entry.slot];
        const probeDistance: number = this.gamePhysicsService.getNextStepArea(opponentCar).maxDistance;
        entry.step.trajectory = new StepTrajectoryModel(probeDistance, entry.step.trajectory.c);
        entry.step.acceleration = CinematicUtils.getAccelerationInUniformlyAcceleratedMotion(startPositioning.speed, probeDistance, 1);
      }
      steps[entry.slot] = {
        positioning: startPositioning,
        move: { // TODO class transformer here
          trajectory: entry.step.trajectory,
          acceleration: entry.step.acceleration,
        }
      };
    }
    this.stepsCount++;
    const isPlayAnimation: boolean = !this.isFirstStepSinceStart;
    this.isFirstStepSinceStart = false;
    if (isPlayAnimation) {
      await this.playAnimations(steps);
    }
    if (isFinal) {
      // Game over: reveal the debrief chrome instead of asking for a move.
      this.lobbyConnectionService.finishRace();
      return;
    }
    this.startNewIteration(data)
      .then();
  }

  //TODO divide. first part is actually applying properties from last step, second is starting new iteration
  async startNewIteration(data: { slot: number, step: StepDataModel }[]): Promise<void> {
    if (this.isWaitingPlayers) {
      this.isWaitingPlayers = false;
    }

    //update options from server
    for (let stepData of data) {
      let car: Car = (this.gameStateService.cars.getValue() || [])[stepData.slot];
      if (car) {
        car.setPosition(stepData.step.finalCarProperties.position);
        car.setRotation(stepData.step.finalCarProperties.rotation);
        car.speed = stepData.step.finalCarProperties.speed;
      }
    }
    this.calculateCarPositionsOnRoad();

    if (this.awaitingOwnSubmissionFromBeforeReload) {
      // Already submitted for this round before the reload; consume the flag.
      this.awaitingOwnSubmissionFromBeforeReload = false;
      this.gameStateService.isInSelectionState.next(false);
      this.gameStateService.isSkippedStepWaiting.next(false);
      this.gameStateService.currentStepArcProperties.next(null);
      return;
    }

    const myCar: Car = (this.gameStateService.cars.getValue() || [])[this.gameStateService.mySlot.getValue()];
    let { minDistance, maxDistance, maxSteeringCurvature } = this.gamePhysicsService.getNextStepArea(myCar);
    const skippedMovesRemaining: number = this.gameStateService.skippedMovesRemaining.getValue();
    this.lastRequestedMoveWasSkip = skippedMovesRemaining > 0;
    this.moveRetryCount = 0;
    this.requestAndSubmitMove(myCar, minDistance, maxDistance, maxSteeringCurvature, this.lastRequestedMoveWasSkip)
      .then();
  }

  // Asks for a move (or auto-fills a forced skip), submits it, and retries
  // on rejection — `submit` resolves `{ err }` rather than throwing, and
  // the arc is hidden the moment the player acts, so an unhandled
  // rejection would soft-lock the game. The client's arc is only a
  // prediction; the canister's validate() is the gate.
  private async requestAndSubmitMove(
    myCar: Car, minDistance: number, maxDistance: number, maxSteeringCurvature: number, isSkipped: boolean,
  ): Promise<void> {
    // Fences the retry against the round having already advanced.
    const roundFence = this.stepsCount;
    const trajectory: StepTrajectoryModel = await (isSkipped ?
      this.playerControlService.submitSkippedMove(minDistance, maxDistance, myCar.speed, maxSteeringCurvature) :
      this.playerControlService.askForSelectedPosition(minDistance, maxDistance, myCar.speed, maxSteeringCurvature));
    const newPositionPolarPoint: PolarPoint = trajectory.polarPosition;
    newPositionPolarPoint.theta += myCar.rotation;
    const newPosition: Vector2 = newPositionPolarPoint.cartesianPoint;
    newPosition.x += myCar.x;
    newPosition.y += myCar.y;
    const stepData: StepDataModel = new StepDataModel(
      myCar.getFullPositioning(),
      trajectory,
      CinematicUtils.getAccelerationInUniformlyAcceleratedMotion(myCar.speed, trajectory.l, 1),
    );

    // TODO fully remove this and this field from request when physics will be calculated on backend
    stepData.finalCarProperties = this.gamePhysicsService.simulateMove(
      this.mapData as MapDataModel,
      [ {
        positioning: myCar.getFullPositioning(),
        move: {
          acceleration: CinematicUtils.getAccelerationInUniformlyAcceleratedMotion(myCar.speed, trajectory.l, 1),
          trajectory: trajectory
        }
      }
      ]
    )[0](1);

    // A failure is ambiguous (rejected, or landed with the reply lost). If
    // the round already advanced, the original landed; retrying on top of
    // the new round's own ask would render two overlapping arcs.
    const retryIfStillOwed = () => {
      if (this.stepsCount !== roundFence) return;
      // A closed GatewayWs rejects forever; the chrome shows the banner.
      if (!this.lobbyConnectionService.isConnected) return;
      // Cap + back off: a forced skip has no click to pace retries.
      this.moveRetryCount++;
      if (this.moveRetryCount > GameplayService.MAX_MOVE_RETRIES) {
        console.error(`duel: move rejected ${this.moveRetryCount - 1}x in a row for round ${roundFence} — giving up automatic retry`);
        return;
      }
      const backoffMs = GameplayService.MOVE_RETRY_BASE_BACKOFF_MS * this.moveRetryCount;
      setTimeout(() => {
        if (this.stepsCount !== roundFence) return; // moved on while we waited
        // Refresh first: the original may have landed during the backoff.
        this.lobbyConnectionService.refreshStatus().finally(() => {
          if (this.stepsCount !== roundFence) return;
          this.requestAndSubmitMove(myCar, minDistance, maxDistance, maxSteeringCurvature, isSkipped).then();
        });
      }, backoffMs);
    };
    this.lobbyConnectionService.emitNextStep(stepData)
      .subscribe({
        next: (result: any) => {
          if (result && 'err' in result) {
            console.warn('duel: move rejected by canister, asking again', result.err);
            retryIfStillOwed();
          }
        },
        error: (e: unknown) => {
          console.warn('duel: move submission failed, asking again', e);
          retryIfStillOwed();
        },
      });
  }

  async playAnimations(steps: { positioning: CarPositioningModel, move: Move }[]): Promise<void> {
    this.gameStateService.isInAnimationState.next(true);
    const functions: ((timeOffset: number) => CarPositioningModel)[] = this.gamePhysicsService.simulateMove(this.mapData as MapDataModel, steps);
    return new Promise<void>((resolve) => {
      const beforeRenderSub: Subscription = this.worldSceneService.subscribeOnBeforeRendering()
        .subscribe(() => {
          const pastTime: number = this.gameStateService.currentStepTime / 1000;
          const cars: Car[] = this.gameStateService.cars.getValue() || [];
          for (let slot = 0; slot < steps.length; slot++) {
            cars[slot].setFullPositioning(functions[slot](Math.min(pastTime, 1)));
          }
          this.calculateCarPositionsOnRoad(Math.min(pastTime, 1));
          if (pastTime >= 1) {
            this.activeAnimationSub = null;
            beforeRenderSub.unsubscribe();
            this.gameStateService.isInAnimationState.next(false);
            resolve();
          }
        });
      this.activeAnimationSub = beforeRenderSub;
    });
  }

  private cancelActiveAnimation(): void {
    if (this.activeAnimationSub) {
      this.activeAnimationSub.unsubscribe();
      this.activeAnimationSub = null;
    }
  }

  setRaceResults(raceResults: any) {
    this.raceResults = raceResults;
  }

  getLastRaceResults(): any {
    return this.raceResults;
  }

  private calculateCarPositionsOnRoad(additinalTimeElapsed: number = 0): void {
    if (!this.mapData) {
      throw new Error();
    }
    const results: CarGamePlayPositionModel[] = [];
    const cars: Car[] = this.gameStateService.cars.getValue() || [];
    for (let slot = 0; slot < cars.length; slot++) {
      const car: Car = cars[slot];
      const carPos: Vector2 = car.getPosition();
      const lastCarPositionOnSpline = this.lastCarPositionsOnRoadSpline.get(slot);
      let lineIndex: number = -1;
      let nearSplinesAllowance: number = 0;
      let lap: number = 0;
      if (lastCarPositionOnSpline) {
        const raceTimeElapsedFromLastCalculation: number = this.raceTimestamp + additinalTimeElapsed - lastCarPositionOnSpline.calculatedAt;
        // approximate magic numbers here;
        const carCouldMoveOn: number = (lastCarPositionOnSpline.speed + 20) * raceTimeElapsedFromLastCalculation;
        nearSplinesAllowance = Math.max(2, Math.ceil(carCouldMoveOn / this.mapData.roadSpline.minSegmentLength));
        lineIndex = lastCarPositionOnSpline.pos ? lastCarPositionOnSpline.pos.lineIndex : 0;
        lap = lastCarPositionOnSpline.lap;
      }
      const currentCarPositionOnRoadSpline: CarPositionOnRoadSplineModel = this.mapData.roadSpline.getNearestPointOnSpline(
        new Vector3(carPos.x, carPos.y, 0), lineIndex, nearSplinesAllowance
      );
      const progress: CarLapProgressModel = this.mapData.roadSpline.getLapProgress(currentCarPositionOnRoadSpline);
      if (lastCarPositionOnSpline) {
        if (lastCarPositionOnSpline.progress.lapPercent > 75 && progress.lapPercent < 25) {
          lap++;
          if (lap === FINISH_LAP_COUNT) {
            console.log('Someone finished');
          }
        } else if (lastCarPositionOnSpline.progress.lapPercent < 25 && progress.lapPercent > 75) {
          lap--;
        }
      }
      this.lastCarPositionsOnRoadSpline.set(slot, {
        calculatedAt: this.raceTimestamp + additinalTimeElapsed,
        speed: car.speed,
        pos: currentCarPositionOnRoadSpline,
        progress: progress,
        lap: lap
      });
      results.push(new CarGamePlayPositionModel(
        slot,
        progress,
        lap
      ));
    }
    results.sort((result1, result2): number => {
      return (result2.lapNumber * 100 + result2.progress.lapPercent) -
        (result1.lapNumber * 100 + result1.progress.lapPercent);
    });
    // TODO move away from here
    const myResult = results.find(result => result.slot === this.gameStateService.mySlot.getValue());
    if (myResult?.lapNumber === FINISH_LAP_COUNT) {
      this.lobbyConnectionService.emitFinished(this.stepsCount)
        .subscribe((data: any): void => {
          console.log('Result from emitFinished ' + JSON.stringify(data));
        });
    }
    this.gameStateService.playerPositions.next(results);
  }

}
