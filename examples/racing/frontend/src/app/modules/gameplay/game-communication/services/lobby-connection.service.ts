import { BehaviorSubject, from, Observable, of, Subject } from 'rxjs';
import { Vector2 } from 'three';
import StepDataModel from '../../gameplay/models/gameplay/control/step-data.model';
import StepTrajectoryModel from '../../gameplay/models/gameplay/control/step-trajectory.model';
import CarPositioningModel from '../../gameplay/models/gameplay/world/car-positioning.model';
import LobbyRuntimeDataModel from '../../gameplay/models/gameplay/lobby/lobby-runtime-data.model';
import PlayerModel from '../../gameplay/models/gameplay/entities/player.model';
import { CarData } from '../../../api/interfaces/car.interfaces';
import { getDuelTransport, getSid } from '../utils/duel-actor';
import { RacingAction, RacingCarState, RacingState } from '../interfaces/racing-state.interfaces';
import { GameStateService } from '../../game-shared/services/game-state.service';
import { CinematicUtils } from '../../../../../utils/cinematic.utils';

// Keep in sync with RacingRules.mo's car constants.
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

/// Approximates the opponent's arc from two observed positions, purely
/// for animation; the canister's `after` position is authoritative.
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

/// Bridges duel-app.js's shared `DuelTransport` to the `{ slot, step }[]`
/// events gameplay.service.ts expects. NO polling of its own: a second
/// poll loop would race the shared one and deliver views out of order.
export class LobbyConnectionService {

  // `isFinal: true` once per race: animate, then finishRace().
  public nextStep: Subject<{ steps: { slot: number, step: StepDataModel }[], isFinal: boolean }> = new Subject();
  // Interface parity only; the canister ends the game itself.
  public finish: Observable<number> = new Observable<number>();
  public lobbyData: BehaviorSubject<LobbyRuntimeDataModel | null> = new BehaviorSubject<LobbyRuntimeDataModel | null>(null);
  // Once per race this instance has seen (a reload mid-race included):
  // `resumedAtStep` is the canister's true round, `youAlreadySubmitted`
  // its View.youSubmitted, so startRace() can seed itself correctly.
  public raceStarted: Subject<{ resumedAtStep: number, youAlreadySubmitted: boolean }> = new Subject();

  private transport: any; // shared DuelTransport — see duel-game-core/transport.js
  private mySlot: number = -1;
  private wasInGame: boolean = false;
  private prevGame: RacingState | null = null;
  private pendingMine: StepDataModel | null = null;
  // The engine's own gen/step from the latest #inGame view — what
  // `submit`/`leave` must stamp (a stale one is rejected as `#stale`).
  private currentGen: bigint = 0n;
  private currentStep: bigint = 0n;
  // Keeps body.in-race up until the final step has been animated.
  private awaitingFinalAnimation: boolean = false;

  constructor(private readonly gameStateService: GameStateService) {
  }

  public get isSocketAvailable(): boolean {
    return true;
  }

  // Read live: duel-app.js's start() writes this key from a separate
  // script, and an early cached read once captured "" for good.
  private get sid(): string {
    return getSid();
  }

  /// False once the shared `DuelTransport` has closed for good.
  public get isConnected(): boolean {
    return !!this.transport && !this.transport.closed;
  }

  /// Subscribes to the shared connection; returns `raceStarted`.
  public connectToLobby(): Observable<{ resumedAtStep: number, youAlreadySubmitted: boolean }> {
    this.init().then();
    return this.raceStarted.asObservable();
  }

  public disconnectFromLobby(): void {
    if (this.transport) this.transport.removeEventListener('message', this.onMessage);
  }

  emitLoadingStateChanged(isLoading: boolean): Observable<any> {
    if (!isLoading && this.prevGame) {
      this.nextStep.next({ steps: this.buildInitialSteps(this.prevGame), isFinal: false });
    }
    return of(null);
  }

  /// Called once the final step has been animated.
  public finishRace(): void {
    this.awaitingFinalAnimation = false;
    document.body.classList.remove('in-race');
  }

  emitNextStep(data: StepDataModel): Observable<any> {
    this.pendingMine = data;
    const trajectory = data.trajectory || new StepTrajectoryModel(0, 0);
    const action: RacingAction = { l: trajectory.l, c: trajectory.c };
    // `request()` resolves this call's own reply; the caller checks `err`.
    return from(this.transport.request(this.sid, { submit: { gen: this.currentGen, step: this.currentStep, move: action } }));
  }

  emitFinished(stepsCount?: number): Observable<any> {
    return of(null);
  }

  /// The same `leave` the Forfeit button sends; used when the track fails
  /// to load, so both seats get a shared `#aborted` debrief.
  public async forfeit(): Promise<void> {
    if (!this.transport) return;
    try {
      await this.transport.request(this.sid, { leave: { gen: this.currentGen } });
    } catch (err) {
      console.error('duel: auto-forfeit request failed', err);
    }
  }

  private async init(): Promise<void> {
    this.transport = await getDuelTransport();
    this.transport.addEventListener('message', this.onMessage);
    // Immediate status fetch; the reply arrives through onMessage.
    this.refreshStatus();
  }

  /// Fires a `#status` request; the view still arrives via onMessage.
  public async refreshStatus(): Promise<void> {
    if (!this.transport) return;
    try {
      await this.transport.request(this.sid, { status: null });
    } catch (e: unknown) {
      console.error('duel status refresh failed', e);
    }
  }

  // Class field for a stable add/removeEventListener reference.
  private onMessage = (ev: MessageEvent): void => {
    const data = ev.data;
    if (data && 'view' in data) this.onStatus(data.view);
  };

  // `status` is a `SessionStatus`; `browsing` is treated as not in a race.
  private onStatus(status: any): void {
    const view = 'atTable' in status ? status.atTable.view : null;
    const inGameNow = !!view && 'inGame' in view;
    if (inGameNow) {
      document.body.classList.add('in-race');
      const v = view.inGame;
      // Refreshed on every #inGame view.
      this.currentGen = v.gen;
      this.currentStep = v.step;
      const slot = 'p1' in v.seat ? 0 : 1;
      const game: RacingState = v.game;
      const isNewRace = !this.wasInGame;
      this.wasInGame = true;
      this.mySlot = slot;
      this.gameStateService.mySlot.next(slot);
      if (isNewRace) {
        // A fresh race, a rematch, or a reload mid-race. Drop the previous
        // race's bookkeeping (a stale prevGame would reconstruct a bogus giant
        // step), re-push lobbyData for fresh Car instances, and pass the true
        // round and youSubmitted through to startRace().
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

    // A game-ending move goes straight from #active to #debrief in one
    // call, so its final state never appears in an #inGame view; deliver
    // it as one last step and keep the 3D view up until it's animated.
    if (this.wasInGame && view && 'debrief' in view && this.prevGame) {
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
        // My trajectory is real, but finalCarProperties/crashPenaltyRemaining
        // were a local prediction; overwrite with the canister's values.
        this.pendingMine.finalCarProperties = toPositioning(after);
        this.pendingMine.crashPenaltyRemaining = Number(after.crashPenaltyRemaining);
        return { slot, step: this.pendingMine };
      }
      const before = slot === 0 ? prevGame.p1 : prevGame.p2;
      const trajectory = reconstructTrajectory(before, after);
      const acceleration = CinematicUtils.getAccelerationInUniformlyAcceleratedMotion(before.speed, trajectory.l, 1);
      // A newly armed penalty means the move was clamped; the fit above is
      // only a chord, so gameplay.service.ts replaces its magnitude.
      const crashed = Number(after.crashPenaltyRemaining) > Number(before.crashPenaltyRemaining);
      return {
        slot,
        step: new StepDataModel(toPositioning(after), trajectory, acceleration, crashed, Number(after.crashPenaltyRemaining)),
      };
    });
  }

}
