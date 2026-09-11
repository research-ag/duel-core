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

// Must match RacingRules.mo's LAPS_TO_WIN — this is only used to detect
// (client-side, for a console.log and to call emitFinished()) that a lap
// just completed matches the win condition; the canister's own resolve()
// is what's actually authoritative for ending the game.
const LAPS_TO_WIN = 1;
// `lap` (below, and CarGamePlayPositionModel.lapNumber) counts wrap-boundary
// crossings, not real laps driven — the starting grid sits right before the
// track's own wrap point, so the very first step of a race already crosses
// it once "for free". Finishing LAPS_TO_WIN real laps takes LAPS_TO_WIN + 1
// raw crossings — see RacingRules.mo's `resolve` comment, which this must
// stay in sync with.
const FINISH_LAP_COUNT = LAPS_TO_WIN + 1;

export class GameplayService {

  isWaitingPlayers: boolean = false;

  private mapData: MapDataModel | undefined;
  private stepsCount: number = 0;
  // Set true by startRace(), cleared the moment the FIRST onStepComplete()
  // after it runs — decouples "should this step animate" from stepsCount's
  // actual value, since startRace() now seeds stepsCount from the
  // canister's true round count on a mid-race reload (see its own doc)
  // rather than always 0. The very first step after (re)starting is
  // always a snap to the current position, never an animation, whether
  // that's round 0 of a fresh race or round 40 of one just reconnected to.
  private isFirstStepSinceStart: boolean = true;
  // Set true by startRace() when the canister's own View.youSubmitted
  // said my move for the CURRENT round was already locked in when this
  // (re)start fired (a reload after submitting, before the opponent
  // moved) — consumed (reset false) by the very next startNewIteration()
  // to skip asking for (and submitting) a SECOND move for a round I've
  // already committed to server-side. Doing that unconditionally used to
  // show a stale, wrong selection arc alongside the chrome's own correct
  // "Move locked in" message, and the resulting rejected resubmission's
  // bogus trajectory corrupted the eventual animation once the opponent
  // actually moved — see startRace()'s own doc.
  private awaitingOwnSubmissionFromBeforeReload: boolean = false;
  // whether the move whose result is about to arrive (the one most recently requested for mySlot)
  // was a forced skip (crash penalty) rather than a real player-selected move
  private lastRequestedMoveWasSkip: boolean = false;
  private lastCarPositionsOnRoadSpline: Map<number, { calculatedAt: number, speed: number, pos: CarPositionOnRoadSplineModel, progress: CarLapProgressModel, lap: number }> = new Map<number, { calculatedAt: number; speed: number; pos: CarPositionOnRoadSplineModel; progress: CarLapProgressModel; lap: number }>();
  private raceResults: any;
  // How many times requestAndSubmitMove()'s own retry has re-fired for the
  // CURRENT round (roundFence) without a real round advance in between —
  // reset to 0 every time startNewIteration() kicks off a genuinely NEW
  // round. See retryIfStillOwed()'s own doc: without a cap, a PERSISTENT
  // rejection (not a transient blip) during a forced-skip step — which has
  // no player click to naturally pace it — would retry in an unbounded
  // tight loop, hammering the canister forever instead of ever giving up.
  private moveRetryCount: number = 0;
  private static readonly MAX_MOVE_RETRIES = 5;
  private static readonly MOVE_RETRY_BASE_BACKOFF_MS = 500;
  // Guards ONLY the scene setup inside init(), separately from
  // `main.ts`'s own `sceneInitialized` (which guards the WHOLE of
  // init()): when init()'s own loadMap() call fails, main.ts
  // deliberately leaves its flag false so the NEXT raceStarted retries
  // by calling init() again — but worldSceneService.init()/
  // controlSceneService.init() are NOT idempotent (each subscribes
  // scene-lifecycle observables — see their own init()), so re-running
  // them on that retry duplicated canvases/subscriptions instead of just
  // retrying the one step that actually failed. Once scene setup has
  // genuinely succeeded, every later init() call — retry or not — skips
  // straight to (re)trying loadMap() alone. See init()'s own doc.
  private sceneReady: boolean = false;

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

  // One-time page-lifetime setup: 3D scenes and the map load once and are
  // reused for every race (rematch or not) — see resetForNewRace() for
  // what actually needs to reset between races.
  async init(): Promise<void> {
    if (!this.sceneReady) {
      await Promise.all([this.worldSceneService.init(), this.controlSceneService.init()]);
      this.sceneReady = true;
    }
    //TODO: get map name from lobby item
    try {
      this.mapData = await this.mapLoaderService.loadMap();
    } catch (err) {
      // model-loader.service.ts already retried this a few times — if it
      // still won't load (e.g. the asset canister is returning 502s),
      // there's no track to race on and no point waiting forever: forfeit
      // this race instead of leaving the player (and their opponent, who
      // has no visibility into this tab's asset load at all) stuck on a
      // permanent loading screen. main.ts's caller leaves
      // `sceneInitialized` false on this failure, so the NEXT race
      // (rematch, or this same table if the outage was transient) tries
      // loading the map again from scratch.
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

  // Runs once per race — the first one, and again on every rematch (see
  // LobbyConnectionService.raceStarted). Also runs when a page reload
  // lands back in a race already under way — from THIS service's point
  // of view that's indistinguishable from "a race just started" (it's a
  // page-lifetime singleton, but it's never lived through the earlier
  // part of this race). `resumedAtStep` is the canister's true current
  // round (0 for a genuinely fresh race, nonzero on a reload) — seeding
  // stepsCount from it, instead of always 0, keeps the HUD's elapsed-time
  // clock (see GameStateService.resetRaceClock) and the lap-tracking
  // cache's own timestamps consistent with the ACTUAL race progress
  // rather than restarting from zero and staying permanently offset for
  // the rest of the race. `youAlreadySubmitted` is the canister's own
  // View.youSubmitted at that same moment — see
  // awaitingOwnSubmissionFromBeforeReload's own doc for why startRace()
  // must NOT always ask for a fresh move here. Every field below must be
  // reset explicitly here regardless — skipping this on a rematch would
  // leak the previous race's crash-recovery/skip state straight into the
  // new one.
  startRace(resumedAtStep: number = 0, youAlreadySubmitted: boolean = false) {
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

  // `isFinal` (see LobbyConnectionService.nextStep's doc) means this is the
  // game-ending step - animate it same as any other, but then hand control
  // back to duel-game-core's own debrief chrome (finishRace()) instead of
  // asking for another move that will never be legal again.
  async onStepComplete(data: { slot: number, step: StepDataModel }[], isFinal: boolean = false): Promise<void> {
    // reset before playAnimations() below runs, so the dimmed skip-arc never lingers into
    // (or flashes back on right at the end of) the animation phase
    this.gameStateService.isSkippedStepWaiting.next(false);
    // TODO switch to use array like this everywhere
    const steps: { positioning: CarPositioningModel, move: Move }[] = [];
    for (const entry of data) {
      // must be read before playAnimations() below mutates the car to this step's final position
      const startPositioning: CarPositioningModel = (this.gameStateService.cars.getValue() || [])[entry.slot].getFullPositioning();
      if (entry.slot === this.gameStateService.mySlot.getValue()) {
        // Trust the canister's own authoritative crashPenaltyRemaining
        // (threaded through by lobby-connection.service.ts's buildSteps/
        // buildInitialSteps — see StepDataModel.crashPenaltyRemaining)
        // instead of re-predicting locally whether this move crashed. This
        // used to run its own local hasCrashed() check to decide whether
        // to force the next 2 moves to a stop; the two collision
        // implementations (this app's vs RacingRules.mo's) are independent
        // code and can disagree on edge cases, and a local false negative
        // there was a real soft lock: the arc kept showing as a normal,
        // free selection while the canister kept rejecting every
        // submission with "recovering from a crash". Reading the value the
        // canister already reports removes the possibility of disagreeing
        // with it.
        this.gameStateService.skippedMovesRemaining.next(entry.step.crashPenaltyRemaining);
      } else if (entry.step.crashed && entry.step.trajectory) {
        // The opponent's real trajectory is hidden - lobby-connection.service.ts's
        // reconstructTrajectory() only fits a chord through the canister's
        // boundary-clamped end position, and for a crash that fit can require an
        // implausible arc (very tight radius, or even flip to a spurious "reverse"
        // interpretation - see StepTrajectoryModel.fromPolarPosition's theta>90°
        // branch) to land exactly on that point, which visibly drives the car
        // outside the map before snapping back at the end of the animation.
        // RacingRules.mo never arms crashPenaltyRemaining on a reversing
        // collision (see this repo's ../../../../../../../../CLAUDE.md), so a
        // crashed step's real move is guaranteed l >= 0 - replace the fit's
        // magnitude with a plausible forward probe distance (fromPolarPosition's
        // curvature is branch-invariant, see its comment, so it's still trustworthy)
        // and let our own collision search (identical math to the canister's -
        // see find-trajectory-collision-with-map.ts) freeze the animation right
        // at the wall, the same way it already does for our own crashes above.
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
    // The first step delivered after (re)starting is always a snap to the
    // current position (see startRace()'s own doc) — NOT `stepsCount > 1`,
    // which only worked back when stepsCount was unconditionally 0 at the
    // start of every race; it now seeds from the true round count on a
    // mid-race reload, so a fixed threshold would wrongly animate the
    // very first (sync) step there.
    const isPlayAnimation: boolean = !this.isFirstStepSinceStart;
    this.isFirstStepSinceStart = false;
    if (isPlayAnimation) {
      await this.playAnimations(steps);
    }
    if (isFinal) {
      // Game over - the canister already resolved this off the winning/
      // losing move (see LobbyConnectionService.nextStep's doc), so there's
      // no legal next move to ask for. This is what actually reveals
      // duel-game-core's own debrief chrome (see finishRace()'s doc).
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
      // My move for THIS round is already locked in server-side (see
      // startRace()'s own doc) — cars are now positioned correctly, but
      // don't ask for (and submit) a second one. Only ever true for the
      // very first startNewIteration() after a (re)start, so consume it
      // now: once the round I already submitted for actually resolves,
      // the normal nextStep-driven flow reaches here again with this
      // false, and asks for the NEXT round's move as usual.
      this.awaitingOwnSubmissionFromBeforeReload = false;
      this.gameStateService.isInSelectionState.next(false);
      this.gameStateService.isSkippedStepWaiting.next(false);
      this.gameStateService.currentStepArcProperties.next(null);
      return;
    }

    const myCar: Car = (this.gameStateService.cars.getValue() || [])[this.gameStateService.mySlot.getValue()];
    let { minDistance, maxDistance, maxSteeringCurvature } = this.gamePhysicsService.getNextStepArea(myCar);
    // Already the canister's own authoritative value as of the step that
    // just resolved (onStepComplete() above sets it straight from
    // entry.step.crashPenaltyRemaining) - no manual decrement needed here
    // anymore; the next resolved step will update it again from truth.
    const skippedMovesRemaining: number = this.gameStateService.skippedMovesRemaining.getValue();
    this.lastRequestedMoveWasSkip = skippedMovesRemaining > 0;
    // A genuinely NEW round starting — reset the retry budget so a run of
    // rejections on a PAST round can't eat into this one's (see
    // moveRetryCount's own doc).
    this.moveRetryCount = 0;
    this.requestAndSubmitMove(myCar, minDistance, maxDistance, maxSteeringCurvature, this.lastRequestedMoveWasSkip)
      .then();
  }

  // Asks the player to pick a move (or auto-fills a forced skip - see
  // player-control.service.ts), submits it, and - this is the part that
  // didn't used to exist - checks whether the canister actually accepted
  // it. `submit` never throws for a business rejection (see idl.js: it
  // resolves `{ ok }` or `{ err }`), and askForSelectedPosition/
  // submitSkippedMove both already hid the selection arc the moment the
  // player acted (see isInSelectionState.next(false) there) - so an `err`
  // (or a transport-level failure reaching the canister at all) used to
  // leave the game stuck: arc gone, no pending move, nothing ever arriving
  // on lobbyConnectionService.nextStep to unstick it. Retrying re-asks
  // (which re-shows the arc, since that's what askForSelectedPosition/
  // submitSkippedMove already do on every call) instead of leaving the
  // player soft-locked. The client's own arc (getNextStepArea above,
  // driven by skippedMovesRemaining - itself now synced straight from the
  // canister's own crashPenaltyRemaining, see onStepComplete()) is still
  // only ever a prediction of what validate() will accept; validate() on
  // the canister is the actual gate (see ../../../../../../CLAUDE.md's
  // "validate is the only legality gate") and can in principle still
  // disagree in other edge cases - e.g. this car's speed changing between
  // when the arc was computed and when the click landed.
  private async requestAndSubmitMove(
    myCar: Car, minDistance: number, maxDistance: number, maxSteeringCurvature: number, isSkipped: boolean,
  ): Promise<void> {
    // Fences the retry below against the round having ALREADY advanced
    // through the normal channel (onStepComplete -> startNewIteration,
    // triggered by lobbyConnectionService.nextStep) while this attempt
    // was in flight — see the retry callbacks' own comment for why that
    // matters. Stable to capture here: the round can't resolve (and so
    // stepsCount can't advance) until AFTER my own move lands, and I
    // haven't submitted yet at this point.
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

    // Retrying here re-asks the player and resubmits with the SAME
    // (myCar, minDistance, maxDistance, maxSteeringCurvature, isSkipped)
    // this attempt used — safe ONLY if the round this was for hasn't
    // already moved on. An `err`/thrown failure here is ambiguous: it
    // can mean the submission was genuinely rejected, OR that it
    // actually landed and just the RESPONSE got lost (a network hiccup,
    // more likely right after a crash since RacingRules.mo's collision
    // walk makes resolve() slower than an ordinary move) — ws.request()
    // already resolves this specific call's OWN result directly (see
    // its own doc), so the retry itself is never what shows a confusing
    // "you already moved" toast any more, but blindly resubmitting
    // anyway is still wrong: if the original attempt DID land, the
    // round may have already advanced through the normal channel
    // (onStepComplete -> startNewIteration, driven by
    // lobbyConnectionService.nextStep) by the time this callback runs —
    // that flow has ALREADY asked for and is tracking the NEXT round's
    // move using fresh car state. A retry firing on top of that would
    // run a second, uncoordinated askForSelectedPosition/
    // submitSkippedMove cycle against STALE bounds computed for the OLD
    // round, pushing its own arc/selection-state updates alongside the
    // legitimate ones with no ordering between them — this is what
    // produced two overlapping, differently-sized arcs (and a
    // speed/camera mismatch to match) rendered at once. `roundFence`
    // (captured before this attempt asked for a move) catches exactly
    // that: if stepsCount has moved on, the original submission already
    // did its job — do nothing further and let the normal flow own it.
    const retryIfStillOwed = () => {
      if (this.stepsCount !== roundFence) return;
      // The shared `GatewayWs` gives up on a dead connection on its own
      // (see duel-game-core/ws/gateway-client.js's disconnect doc) — once it has,
      // ws.request() rejects immediately, every time, forever. Retrying
      // anyway would spin a tight loop doing nothing but reject again
      // (submitSkippedMove's forced-skip path resolves instantly, with
      // no click to naturally pace it) — app.js's own chrome already
      // shows a persistent "Connection closed" banner once this happens,
      // so there's nothing productive left to do here.
      if (!this.lobbyConnectionService.isConnected) return;
      // Cap + back off: a forced skip has no player click to naturally
      // pace retries, so a PERSISTENT (not transient) rejection would
      // otherwise spin this in an unbounded tight loop hammering the
      // canister forever (moveRetryCount's own doc). Give up automatic
      // retry past MAX_MOVE_RETRIES rather than that — the normal
      // nextStep-driven flow still owns recovery if the round ever does
      // resolve through some other path.
      this.moveRetryCount++;
      if (this.moveRetryCount > GameplayService.MAX_MOVE_RETRIES) {
        console.error(`duel: move rejected ${this.moveRetryCount - 1}x in a row for round ${roundFence} — giving up automatic retry`);
        return;
      }
      const backoffMs = GameplayService.MOVE_RETRY_BASE_BACKOFF_MS * this.moveRetryCount;
      setTimeout(() => {
        if (this.stepsCount !== roundFence) return; // moved on while we waited
        // Refresh the authoritative view before resubmitting — if the
        // ORIGINAL attempt actually landed (see this function's own doc:
        // an err/thrown failure here is ambiguous), the round may already
        // have resolved through the normal channel while this backoff
        // elapsed, advancing stepsCount out from under roundFence on its
        // own; re-checking once more after the refresh's own round trip
        // catches that race too, not just the one right above.
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
          // ok: nothing else to do - the resolved step arrives through the
          // regular status poll (see lobby-connection.service.ts's nextStep).
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
            beforeRenderSub.unsubscribe();
            this.gameStateService.isInAnimationState.next(false);
            resolve();
          }
        });
    });
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
