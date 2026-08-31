import { BehaviorSubject, combineLatest } from 'rxjs';
import Car from '../../gameplay/models/gameplay/entities/car.model';
import StepTrajectoryModel from '../../gameplay/models/gameplay/control/step-trajectory.model';
import LobbyRuntimeDataModel from '../../gameplay/models/gameplay/lobby/lobby-runtime-data.model';
import CarGamePlayPositionModel from '../../gameplay/models/gameplay/helpers/car-game-play-position.model';
import MapDataModel from '../../gameplay/models/gameplay/world/map-data.model';
import { distinctUntilChanged, map } from 'rxjs/operators';

/**
 * all runtime data is just stored and populated from here
 * */
export class GameStateService {

  public mySlot: BehaviorSubject<number> = new BehaviorSubject<number>(-1);
  // true when we show next step area and waiting for user click
  public isInSelectionState: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  // true when we show next step area and waiting for user click
  public isInAnimationState: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);
  // contains area to click
  public currentStepArcProperties: BehaviorSubject<{ maxSteeringCurvature: number, minDistance: number, maxDistance: number, momentumDistance: number } | null>
    = new BehaviorSubject<{ maxSteeringCurvature: number, minDistance: number, maxDistance: number, momentumDistance: number } | null>(null);
  // contains trajectory under user cursor
  public currentlySelectedTrajectory: BehaviorSubject<StepTrajectoryModel | null> = new BehaviorSubject<StepTrajectoryModel | null>(null);
  // car, which is viewed by camera, for now it's just player car
  public trackingCar: BehaviorSubject<Car | null> = new BehaviorSubject<Car | null>(null);
  // lobby data from backend
  public runtimeData: BehaviorSubject<LobbyRuntimeDataModel | null> = new BehaviorSubject<LobbyRuntimeDataModel | null>(null);
  // player positions
  public playerPositions: BehaviorSubject<CarGamePlayPositionModel[] | null> = new BehaviorSubject<CarGamePlayPositionModel[] | null>(null);
  public mapData: BehaviorSubject<MapDataModel | null> = new BehaviorSubject<MapDataModel | null>(null);
  public cars: BehaviorSubject<Car[] | null> = new BehaviorSubject<Car[] | null>(null);
  // temporary disable mouse control (for instance if menu opened)
  public controlsEnabled: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(true);
  // number of upcoming moves forced to zero movement as a crash penalty (car is already stationary)
  public skippedMovesRemaining: BehaviorSubject<number> = new BehaviorSubject<number>(0);
  // true while a forced zero-movement move has been auto-submitted and we're waiting on other players;
  // used to render the step-selection arc dimmed and non-interactive instead of hiding it
  public isSkippedStepWaiting: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

  private stepsElapsed: number = -1;
  private _lastStepStartTimestamp: number = 0;

  constructor() {
    // TODO think about moving it out of here
    this.isInAnimationState.asObservable()
      .pipe(
        distinctUntilChanged()
      )
      .subscribe((isInAnimationState: boolean) => {
        if (!isInAnimationState) {
          this.stepsElapsed++;
          this._lastStepStartTimestamp = 0;
        } else {
          this._lastStepStartTimestamp = Date.now();
        }
      });
    this.runtimeData.asObservable()
      .pipe(
        map((runtimeData) => {
          return runtimeData && runtimeData.players ? runtimeData.players.map(player => player.car) : [];
        }),
        map(cars => cars.map(car => car && Car.fromDTO(car)).filter(car => !!car) as Car[])
      )
      .subscribe(this.cars);
    combineLatest([
      this.cars,
      this.mySlot,
    ])
      .pipe(
        map(([ cars, mySlot ]): Car | null => {
          return cars && cars[mySlot];
        }),
        distinctUntilChanged()
      )
      .subscribe(this.trackingCar);
  }

  // Called once per race by gameplay.service.ts's startRace(). This service
  // is a page-lifetime singleton, never recreated between races, so
  // stepsElapsed must be reset explicitly here — a rematch that skipped
  // this call would carry the previous race's clock straight into the new
  // one.
  public resetRaceClock(): void {
    this.stepsElapsed = -1;
    this._lastStepStartTimestamp = 0;
  }

  // current step elapsed time in milliseconds (0 - 1000)
  public get currentStepTime(): number {
    // TODO 1000 is hardcoded step duration. switch to using value from lobby settings
    const stepDuration: number = 1000;
    return Math.min(stepDuration, Date.now() - this._lastStepStartTimestamp);
  }

  // race world time elapsed in milliseconds
  public get raceTime(): number {
    // TODO 1000 is hardcoded step duration. switch to using value from lobby settings
    const stepDuration: number = 1000;
    return this.stepsElapsed * stepDuration + (this._lastStepStartTimestamp && this.currentStepTime);
  }

}
