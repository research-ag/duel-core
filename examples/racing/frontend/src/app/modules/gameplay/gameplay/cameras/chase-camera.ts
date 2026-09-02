import { Camera, Object3D, Vector3 } from 'three';
import { ThreeScene } from '../../game-viewport/entities/three-scene';
import { BaseCameraService } from './base-camera.service';
import { Subject } from 'rxjs';

export class ChaseCamera extends BaseCameraService {

  constructor(
    protected readonly scene: ThreeScene,
    protected readonly object: Object3D,
  ) {
    super(scene, scene.camera$.getValue() as Camera);
  }

  protected calculateCameraPosition(): Vector3 {
    return new Vector3(
      this.object.position.x + 3,
      this.object.position.y + 4,
      this.object.position.z + 2,
    );
  }

  protected calculateCameraTargetPosition(): Vector3 {
    return this.object.position.clone();
  }
}
