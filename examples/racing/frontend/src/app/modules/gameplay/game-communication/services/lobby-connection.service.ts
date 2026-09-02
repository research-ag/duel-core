import { BehaviorSubject, from, Observable, of, Subject } from 'rxjs';
import { Vector2 } from 'three';
import StepDataModel from '../../gameplay/models/gameplay/control/step-data.model';
import StepTrajectoryModel from '../../gameplay/models/gameplay/control/step-trajectory.model';
import CarPositioningModel from '../../gameplay/models/gameplay/world/car-positioning.model';
import LobbyRuntimeDataModel from '../../gameplay/models/gameplay/lobby/lobby-runtime-data.model';
import PlayerModel from '../../gameplay/models/gameplay/entities/player.model';
import { CarData } from '../../../api/interfaces/car.interfaces';
import { getDuelWs, getSid } from '../utils/duel-actor';
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
/// is to notice (by sharing duel-app.js's own push connection — see
/// getDuelWs()) when a game is under way, and translate it into the
/// `{ slot, step }[]` event shape gameplay.service.ts already expects —
/// so nothing downstream of here needed to change. This service has NO
/// polling of its own: `onMessage()` just reacts to whatever view the
/// shared `GatewayWs` delivers next (canister push, plus immediately
/// after every submitted move — see emitNextStep()) — a second,
/// independent poll loop here would race the shared connection's own
/// fetches with no ordering guarantee between them, which is exactly
/// what once made cars briefly animate backwards before "teleporting"
/// to the correct position, back when this ran over a plain-polling
/// transport (since removed — see `examples/racing/CLAUDE.md`'s
/// "cars occasionally animated backwards" history for the full story).
/// There's no plain-polling fallback anywhere
/// in `duel-game-core` any more — `duel-app.js`'s `ws` always exists, and
/// this is the only communication channel to the canister, chrome and
/// race alike.
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
  // Fires once per race THIS SERVICE INSTANCE has seen — the very first
  // one (whether that's a genuinely fresh race or a page reload landing
  // back in one already under way), and again on every rematch (detected
  // as a not-in-game -> in-game transition, since a rematch always passes
  // back through #debrief/#awaitingRematch first). This is the ONLY
  // reliable "start of a new race, from this service's point of view"
  // signal: the canister's own per-race counters (RacingState.step, the
  // engine's own `turn`) both reset to 0 for a rematch same as for the
  // first game, so they can't distinguish "new race" from "impossible
  // step regression" on their own. `resumedAtStep` is the round the
  // canister was ACTUALLY at when this fired — 0 for a genuinely fresh
  // race, but nonzero when reconnecting mid-race (a reload) — so
  // gameplay.service.ts's startRace() can seed its own step/clock
  // counters correctly instead of always assuming a 0-start.
  // `youAlreadySubmitted` is the canister's own View.youSubmitted at that
  // same moment — true when reconnecting mid-round with my own move
  // already locked in — so startRace() can sync car positions/HUD
  // without ALSO asking for (and submitting) a second move for a round
  // I've already committed to. See onStatus()'s own comment on both.
  public raceStarted: Subject<{ resumedAtStep: number, youAlreadySubmitted: boolean }> = new Subject();

  private ws: any; // shared GatewayWs — see duel-game-core/ws/gateway-client.js
  private mySlot: number = -1;
  private wasInGame: boolean = false;
  private prevGame: RacingState | null = null;
  private pendingMine: StepDataModel | null = null;
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

  // Read LIVE on every use, never cached: sessionStorage's "sid" key is
  // written by duel-app.js's own start() (see its own comments), a
  // SEPARATE script from this one — caching a single early read here
  // raced that write and could permanently capture "" (getSid()'s
  // not-set fallback) for the rest of the session, since nothing ever
  // re-read it afterward. That's exactly what produced "You are not
  // seated in this game." on a session's first submitted move: an empty
  // sid isn't seated in anything, and every subsequent move kept reusing
  // the same wrong, cached value. By the time a player can actually
  // submit a move, they've already joined through duel-app.js's own UI,
  // which only exists once its start() has already run and written the
  // real sid — so a live read here is always safe AND simpler than
  // reasoning about which of two separately-loaded scripts runs first.
  private get sid(): string {
    return getSid();
  }

  /// False once the shared `GatewayWs` has given up (see
  /// duel-game-core/ws/gateway-client.js's `closed`/disconnect doc) — used by
  /// gameplay.service.ts's requestAndSubmitMove() to stop retrying a
  /// submit against a connection that's already gone, rather than
  /// spinning a tight retry loop against it (app.js's own chrome already
  /// shows "Connection closed — reload to reconnect" once this happens).
  public get isConnected(): boolean {
    return !!this.ws && !this.ws.closed;
  }

  /// Subscribes to the shared push poller and returns `raceStarted` —
  /// subscribe to it for "a race is under way" events, fired once per
  /// race (see its own doc).
  public connectToLobby(): Observable<{ resumedAtStep: number, youAlreadySubmitted: boolean }> {
    this.init().then();
    return this.raceStarted.asObservable();
  }

  public disconnectFromLobby(): void {
    if (this.ws) this.ws.removeEventListener('message', this.onMessage);
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
    // ws.request() resolves to THIS call's own { view } / { err } (never
    // racing an unsolicited push from the other seat — see
    // gateway-client.js's own doc) and rejects on a genuine transport
    // failure. There is no plain actor.submit() to fall back to at all
    // any more (mutation goes exclusively through ws_message — see the
    // repo root CLAUDE.md's frontend bullet); gameplay.service.ts's requestAndSubmitMove()
    // only ever checks 'err' in result / the Observable's error channel,
    // so its retry logic needed no changes when this moved off the old
    // plain-polling transport.
    return from(this.ws.request(this.sid, { submit: action }));
  }

  emitFinished(stepsCount?: number): Observable<any> {
    return of(null);
  }

  /// Submits a `leave` over the same shared connection/session id
  /// emitNextStep() uses — exactly what clicking duel-game-core's own
  /// "Forfeit" button does (see ../../../../../../../frontend/render.js's
  /// renderInGame/doLeave), just triggered from app code instead of a
  /// click. Used by gameplay.service.ts's init() when the track fails to
  /// load even after retries: rather than leaving this tab stuck forever
  /// on a loading screen the opponent can't see past either, bail out of
  /// the race the same way a human clicking Forfeit would (see
  /// ../../../../../../CLAUDE.md's architecture rule 7 — `leave` from an
  /// active game produces a shared `#aborted` debrief for both seats, it
  /// never leaves a game silently hanging). Swallows its own failure:
  /// this is already the last resort, and if `leave` itself doesn't land
  /// duel-game-core's own chrome will surface the underlying connection
  /// problem on its own (e.g. "Connection closed — reload to
  /// reconnect.").
  public async forfeit(): Promise<void> {
    if (!this.ws) return;
    try {
      await this.ws.request(this.sid, { leave: null });
    } catch (err) {
      console.error('duel: auto-forfeit request failed', err);
    }
  }

  private async init(): Promise<void> {
    this.ws = await getDuelWs();
    this.ws.addEventListener('message', this.onMessage);
    // Kick off an immediate status fetch instead of waiting for the
    // shared poller's first tick — mirrors app.js's own
    // ws.onopen -> refresh(). Its result arrives through onMessage,
    // same as every other view; nothing to do with the return value.
    this.ws.request(this.sid, { status: null })
      .catch((e: unknown) => console.error('duel status request failed', e));
  }

  // Bound as a class field (not a method) so it's a stable reference for
  // addEventListener/removeEventListener across the service's lifetime.
  private onMessage = (ev: MessageEvent): void => {
    const data = ev.data;
    if (data && 'view' in data) this.onStatus(data.view);
  };

  private onStatus(view: any): void {
    const inGameNow = 'inGame' in view;
    if (inGameNow) {
      document.body.classList.add('in-race');
      const v = view.inGame;
      const slot = 'p1' in v.seat ? 0 : 1;
      const game: RacingState = v.game;
      const isNewRace = !this.wasInGame;
      this.wasInGame = true;
      this.mySlot = slot;
      this.gameStateService.mySlot.next(slot);
      if (isNewRace) {
        // Fires for a genuinely fresh race (including a rematch) AND for
        // a page reload landing back in an ALREADY-in-progress race —
        // this service is constructed fresh either way, so `wasInGame`
        // starts false in both cases and can't tell them apart on its
        // own. Drop any bookkeeping from whatever race preceded this one
        // in THIS service instance's lifetime — a rematch's fresh State
        // always starts back at `step == 0`, so comparing it against a
        // stale `prevGame` from the last race would reconstruct a bogus
        // giant "step" connecting the two races (see buildSteps).
        // Re-pushing lobbyData also makes GameStateService hand out
        // brand new Car instances (its cars$ is derived from lobbyData —
        // see game-state.service.ts), clearing any stale position/speed
        // left over from the last race. `game.step` is passed through so
        // gameplay.service.ts's startRace() can seed its own local
        // step/clock counters from the TRUE current round instead of
        // always assuming a fresh 0-start — otherwise a reload mid-race
        // would permanently desync the HUD's elapsed-time clock from the
        // canister's actual round count for the rest of that race (it'd
        // count from 0 instead of from wherever the race actually was).
        // `v.youSubmitted` is ALSO passed through, for the same reason:
        // if this reconnect lands mid-round with my own move already
        // locked in server-side (I submitted, then reloaded before the
        // opponent moved), gameplay.service.ts must NOT ask for another
        // one — see startRace()'s own doc on why that used to show a
        // stale, wrong selection arc alongside the chrome's correct
        // "Move locked in" message, and corrupt the eventual animation
        // with a bogus, rejected resubmission.
        this.prevGame = null;
        this.pendingMine = null;
        this.lobbyData.next(this.buildLobbyRuntimeData());
        this.raceStarted.next({
          resumedAtStep: Number(game.step),
          youAlreadySubmitted: v.youSubmitted,
        });
      }
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
