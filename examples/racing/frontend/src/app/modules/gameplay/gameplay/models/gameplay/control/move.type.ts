import StepTrajectoryModel from './step-trajectory.model';

export type Move = { trajectory: StepTrajectoryModel | null, acceleration: number };
