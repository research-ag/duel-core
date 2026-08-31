import StepTrajectoryModel from '../../../../gameplay/models/gameplay/control/step-trajectory.model';
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Vector2 } from 'three';

export default class TrajectoryDisplayObject extends Mesh {

  public thickness: number;
  private _geometry: BufferGeometry;

  constructor(thickness: number = 0.1) {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(Array(64 * 3).fill(0)), 3)
    );
    const faceIndex = [];
    for (let i = 0; i <= 61; i += 2) {
      faceIndex.push(i, i + 2, i + 1);
      faceIndex.push(i + 1, i + 2, i + 3);
    }
    geometry.setIndex(faceIndex);
    const material: MeshBasicMaterial = new MeshBasicMaterial({ color: 0 });
    super(geometry, material);
    this._geometry = geometry;
    this.thickness = thickness;
  }

  setTrajectory(traj: StepTrajectoryModel): void {
    const points: Vector2[] = traj.breakToSegments(31);
    points.unshift(new Vector2(0, 0));
    let fullAngle: number = -traj.pointerRotation;
    const positions = this._geometry.attributes.position.array;
    points.forEach((pos: Vector2, index: number): void => {
      const angle: number = index * (fullAngle / (points.length - 1));
      // for getting right normals without double sided material
      const index1: number = traj.l >= 0 ? index * 2 : index * 2 + 1;
      const index2: number = traj.l >= 0 ? index * 2 + 1 : index * 2;
      positions[index1 * 3] = pos.x - this.thickness * Math.sin(angle) / 2;
      positions[index1 * 3 + 1] = pos.y - this.thickness * Math.cos(angle) / 2;
      positions[index1 * 3 + 2] = 0.01;
      positions[index2 * 3] = pos.x + this.thickness * Math.sin(angle) / 2;
      positions[index2 * 3 + 1] = pos.y + this.thickness * Math.cos(angle) / 2;
      positions[index2 * 3 + 2] = 0.01;
    });
    this._geometry.attributes.position.needsUpdate = true;
    this._geometry.computeBoundingBox();
    this._geometry.computeBoundingSphere();
  }

}
