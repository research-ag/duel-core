import CarPositioningModel from '../world/car-positioning.model';
import StepTrajectoryModel from './step-trajectory.model';

export default class StepDataModel {

  constructor(
    public finalCarProperties: CarPositioningModel = new CarPositioningModel(),
    public trajectory: StepTrajectoryModel | null = null,
    public acceleration: number = 0,
    // Only meaningful for a RECONSTRUCTED (opponent) step — see
    // lobby-connection.service.ts's buildSteps() and
    // RacingCarState.crashPenaltyRemaining. Tells gameplay.service.ts's
    // onStepComplete() that `trajectory`'s fitted magnitude/sign can't be
    // trusted (see its comment) even though its curvature can.
    public crashed: boolean = false,
    // The canister's OWN authoritative RacingCarState.crashPenaltyRemaining
    // for whichever car this step belongs to, as of right after this step
    // resolved. For mySlot, gameplay.service.ts's onStepComplete() trusts
    // this directly to decide whether the NEXT move must be a forced
    // stop — deliberately not re-derived from a local crash prediction
    // (the two independent collision implementations, JS here vs Motoko
    // on the canister, can disagree on edge cases; trusting a local guess
    // instead of this field is what let a real recovery penalty go
    // undetected client-side, leaving the arc showing as normal while
    // every submitted move kept getting rejected — a soft lock).
    public crashPenaltyRemaining: number = 0,
  ) {

  }

}
