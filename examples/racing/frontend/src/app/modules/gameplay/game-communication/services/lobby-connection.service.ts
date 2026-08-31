import { BehaviorSubject, from, Observable, of, Subject } from 'rxjs';
import { Vector2 } from 'three';
import StepDataModel from '../../gameplay/models/gameplay/control/step-data.model';
import StepTrajectoryModel from '../../gameplay/models/gameplay/control/step-trajectory.model';
import CarPositioningModel from '../../gameplay/models/gameplay/world/car-positioning.model';
import LobbyRuntimeDataModel from '../../gameplay/models/gameplay/lobby/lobby-runtime-data.model';
import PlayerModel from '../../gameplay/models/gameplay/entities/player.model';
import { CarData } from '../../../api/interfaces/car.interfaces';
import { getDuelActor, getSid } from '../utils/duel-actor';
import { RacingAction, RacingCarState, RacingState } from '../interfaces/racing-state.interfaces';
import { GameStateService } from '../../game-shared/services/game-state.service';
import { CinematicUtils } from '../../../../../utils/cinematic.utils';

// This example ships exactly one car and one track — see
// ../../../../../../../src/RacingRules.mo, which independently bakes in
// this SAME car's characteristics (steering/engine/braking/mass/drag) to
// recompute the reachable arc server-side in `validate`. Keep the two in
// sync — see that module's "tuning constants" comment.
const CAR: CarData = {
  name: 'Racer',
  model: 'lambo_aventador',
  steering: 23,
  dragConstant: 0.4257,
  wheelFrictionConstant: 12.8,
  engineForce: 22500,
  brakingForce: 35000,
  mass: 1350,
};

const POLL_MS = 1000;

function toPositioning(car: RacingCarState): CarPositioningModel {
  return new CarPositioningModel(new Vector2(car.position[0], car.position[1]), car.rotation, car.speed);
}

/// Approximates the arc a car must have driven to get from `before` to
/// `after`, purely from the two observed positions/rotations — used to
/// animate the OPPONENT's car the same way the local player's own choice
/// animates (see startNewIteration in gameplay.service.ts). This can't be
/// exact if the real move was clamped by a mid-arc collision, but it's
/// cosmetic: the canister's `after` position (what actually happened) is
/// authoritative either way, this just makes the trip there look smooth.
function reconstructTrajectory(before: RacingCarState, after: RacingCarState): StepTrajectoryModel {
  const dx = after.position[0] - before.position[0];
  const dy = after.position[1] - before.position[1];
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
    return new StepTrajectoryModel(0, 0);
  }
  const cos = Math.cos(-before.rotation);
  const sin = Math.sin(-before.rotation);
  const local = new Vector2(dx * cos - dy * sin, dy * cos + dx * sin);
  return StepTrajectoryModel.fromCartesianPosition(local);
}

/// Talks to the canister instead of a socket.io server: this example has
/// one global lobby (see ../../../../../../../backend/README.md), so
/// there is no lobby URL/slot/car selection here — duel-game-core's own
/// screens (index.html's #screen, driven by duel-app.js) already handle
/// choosing a seat and waiting for an opponent. This service's only job
/// is to notice (by polling the same `status` query the chrome polls)
/// when a game is under way, and translate it into the
/// `{ slot, step }[]` event shape gameplay.service.ts already expects —
/// so nothing downstream of here needed to change.
export class LobbyConnectionService {

  // `isFinal: true` exactly once per race — see the #debrief handling in
  // onStatus() below — telling gameplay.service.ts's onStepComplete() to
  // play this step's animation and then call finishRace() instead of
  // asking for another move.
  public nextStep: Subject<{ steps: { slot: number, step: StepDataModel }[], isFinal: boolean }> = new Subject();
  // Kept for interface parity with the socket.io version; this example's
  // rules already end the game authoritatively (see RacingRules.mo), so
  // there is nothing extra to broadcast here — duel-game-core's own
  // debrief screen already shows the result.
  public finish: Observable<number> = new Observable<number>();
  public lobbyData: BehaviorSubject<LobbyRuntimeDataModel | null> = new BehaviorSubject<LobbyRuntimeDataModel | null>(null);
  // Fires once per race — the very first one, and again on every rematch
  // (detected as a not-in-game -> in-game transition, since a rematch
  // always passes back through #debrief/#awaitingRematch first). This is
  // the ONLY reliable "start of a new race" signal: the canister's own
  // per-race counters (RacingState.step, the engine's own `turn`) both
  // reset to 0 for a rematch same as for the first game, so they can't
  // distinguish "new race" from "impossible step regression" on their own.
  // gameplay.service.ts subscribes to this to reset its own per-race
  // state — see its resetForNewRace().
  public raceStarted: Subject<void> = new Subject();

  private actor: any;
  private sid: string = '';
  private mySlot: number = -1;
  private wasInGame: boolean = false;
  private prevGame: RacingState | null = null;
  private pendingMine: StepDataModel | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  // True from the moment the game-ending step is delivered as a final
  // nextStep (see onStatus()'s #debrief handling) until gameplay.service.ts
  // calls finishRace() once it's actually done animating it - keeps
  // body.in-race (and so the 3D view) up in the meantime instead of
  // snapping straight to duel-game-core's own debrief chrome mid-motion.
  private awaitingFinalAnimation: boolean = false;

  constructor(private readonly gameStateService: GameStateService) {
  }

  public get isSocketAvailable(): boolean {
    return true;
  }

  /// Starts polling and returns `raceStarted` — subscribe to it for "a
  /// race is under way" events, fired once per race (see its own doc).
  public connectToLobby(): Observable<void> {
    this.init().then();
    return this.raceStarted.asObservable();
  }

  public disconnectFromLobby(): void {
    clearTimeout(this.pollTimer);
  }

  emitLoadingStateChanged(isLoading: boolean): Observable<any> {
    if (!isLoading && this.prevGame) {
      this.nextStep.next({ steps: this.buildInitialSteps(this.prevGame), isFinal: false });
    }
    return of(null);
  }

  /// Called by gameplay.service.ts's onStepComplete() once it's finished
  /// animating a step delivered with isFinal: true - only now does the 3D
  /// view hand control back to duel-game-core's own debrief chrome (see
  /// onStatus()'s #debrief handling and style.css's body.in-race).
  public finishRace(): void {
    this.awaitingFinalAnimation = false;
    document.body.classList.remove('in-race');
  }

  emitNextStep(data: StepDataModel): Observable<any> {
    this.pendingMine = data;
    const trajectory = data.trajectory || new StepTrajectoryModel(0, 0);
    const action: RacingAction = { l: trajectory.l, c: trajectory.c };
    return from(this.actor.submit(this.sid, action));
  }

  emitFinished(stepsCount?: number): Observable<any> {
    return of(null);
  }

  private async init(): Promise<void> {
    this.actor = await getDuelActor();
    this.sid = getSid();
    this.poll();
  }

  private poll(): void {
    this.actor.status(this.sid)
      .then((view: any) => this.onStatus(view))
      .catch((e: unknown) => console.error('duel status poll failed', e))
      .finally(() => {
        this.pollTimer = setTimeout(() => this.poll(), POLL_MS);
      });
  }

  private onStatus(view: any): void {
    const inGameNow = 'inGame' in view;
    if (inGameNow) {
      document.body.classList.add('in-race');
      const v = view.inGame;
      const slot = 'p1' in v.seat ? 0 : 1;
      const isNewRace = !this.wasInGame;
      this.wasInGame = true;
      this.mySlot = slot;
      this.gameStateService.mySlot.next(slot);
      if (isNewRace) {
        // Drop any bookkeeping from whatever race preceded this one — a
        // rematch's fresh State always starts back at `step == 0`, so
        // comparing it against a stale `prevGame` from the last race would
        // reconstruct a bogus giant "step" connecting the two races (see
        // buildSteps). Re-pushing lobbyData also makes GameStateService
        // hand out brand new Car instances (its cars$ is derived from
        // lobbyData — see game-state.service.ts), clearing any stale
        // position/speed left over from the last race.
        this.prevGame = null;
        this.pendingMine = null;
        this.lobbyData.next(this.buildLobbyRuntimeData());
        this.raceStarted.next();
      }
      const game: RacingState = v.game;
      if (this.prevGame && Number(game.step) !== Number(this.prevGame.step)) {
        this.nextStep.next({ steps: this.buildSteps(this.prevGame, game), isFinal: false });
        this.pendingMine = null;
      }
      this.prevGame = game;
      return;
    }

    // Leaving #active (debrief, back to lobby, an idle takeover, ...) — the
    // NEXT time we see #inGame is necessarily a new race (see `wasInGame`'s
    // doc). A game-ending move resolves AND transitions the table straight
    // from #active to #debrief within the SAME submit() call (see
    // ../../../../../../backend/src/lib.mo), so there is no separate
    // #inGame poll ever exposing that final RacingState the way every
    // earlier step got one above — without this, the winning/losing move
    // just never got animated at all, jumping straight to duel-game-core's
    // own debrief chrome. Deliver it as one last step instead, and keep the
    // 3D view up (skip clearing body.in-race) until gameplay.service.ts
    // confirms it's actually done animating (see finishRace()).
    if (this.wasInGame && 'debrief' in view && this.prevGame) {
      const finalGame: RacingState = view.debrief.finalGame;
      if (Number(finalGame.step) !== Number(this.prevGame.step)) {
        this.awaitingFinalAnimation = true;
        this.nextStep.next({ steps: this.buildSteps(this.prevGame, finalGame), isFinal: true });
        this.pendingMine = null;
      }
      this.prevGame = finalGame;
    }
    this.wasInGame = false;
    if (!this.awaitingFinalAnimation) {
      document.body.classList.remove('in-race');
    }
  }

  private buildLobbyRuntimeData(): LobbyRuntimeDataModel {
    return new LobbyRuntimeDataModel(
      [0, 1].map(slot => new PlayerModel(slot, CAR)),
    );
  }

  private buildInitialSteps(game: RacingState): { slot: number, step: StepDataModel }[] {
    return [0, 1].map(slot => {
      const car = slot === 0 ? game.p1 : game.p2;
      return { slot, step: new StepDataModel(toPositioning(car), null, 0, false, Number(car.crashPenaltyRemaining)) };
    });
  }

  private buildSteps(prevGame: RacingState, game: RacingState): { slot: number, step: StepDataModel }[] {
    return [0, 1].map(slot => {
      const after = slot === 0 ? game.p1 : game.p2;
      if (slot === this.mySlot && this.pendingMine) {
        // My own trajectory/acceleration are real (I submitted them, not a
        // reconstruction), but finalCarProperties/crashPenaltyRemaining
        // above were only ever a LOCAL prediction (gamePhysicsService.
        // simulateMove(), computed client-side before this round resolved
        // — see startNewIteration()/requestAndSubmitMove()). Overwrite
        // both with the canister's actual resolved values before handing
        // this off: the two collision implementations (this file's vs
        // RacingRules.mo's) are independent code, and trusting the local
        // guess instead of `after` here is what let a real, canister-side
        // crash-penalty go unnoticed client-side — the arc kept showing
        // as normal while every submission kept getting validated away.
        this.pendingMine.finalCarProperties = toPositioning(after);
        this.pendingMine.crashPenaltyRemaining = Number(after.crashPenaltyRemaining);
        return { slot, step: this.pendingMine };
      }
      const before = slot === 0 ? prevGame.p1 : prevGame.p2;
      const trajectory = reconstructTrajectory(before, after);
      const acceleration = CinematicUtils.getAccelerationInUniformlyAcceleratedMotion(before.speed, trajectory.l, 1);
      // A newly-armed crashPenaltyRemaining (0 -> 2, see RacingRules.mo's
      // stepCar) means the canister clamped this move to the track
      // boundary - the opponent's REAL trajectory stays hidden (see
      // ../../../../../../../../CLAUDE.md's "Pending moves are hidden by
      // construction"), so `trajectory` above is only a chord fit through
      // that clamped point, not the real arc. gameplay.service.ts's
      // onStepComplete() uses this flag to replace the fit's magnitude
      // with a proper collision search instead of trusting it as-is.
      const crashed = Number(after.crashPenaltyRemaining) > Number(before.crashPenaltyRemaining);
      return {
        slot,
        step: new StepDataModel(toPositioning(after), trajectory, acceleration, crashed, Number(after.crashPenaltyRemaining)),
      };
    });
  }

}
