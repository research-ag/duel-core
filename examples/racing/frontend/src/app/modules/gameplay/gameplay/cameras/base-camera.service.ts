import { ThreeScene } from '../../game-viewport/entities/three-scene';
import { BehaviorSubject, Observable, Subject } from 'rxjs';
import { Camera, Vector3 } from 'three';
import { distinctUntilChanged, map, takeUntil } from 'rxjs/operators';

export abstract class BaseCameraService {

  private unsubscribeSubj: Subject<void> = new Subject<void>();
  private detached: Subject<void> = new Subject<void>();
  private cameraPosition: BehaviorSubject<[ Vector3, Vector3, Vector3 ]> = new BehaviorSubject<[ Vector3, Vector3, Vector3 ]>([ new Vector3(), new Vector3(), new Vector3() ]);

  constructor(
    protected readonly scene: ThreeScene,
    protected readonly camera: Camera,
  ) {
  }

  start() {
    this.scene.subscribeOnUpdateScene().subscribe(() => {
      this.updateCamera();
    });
  }

  public stop(): void {
    this.detached.next();
    this.unsubscribeSubj.next();
    this.unsubscribeSubj.complete();
  };

  protected abstract calculateCameraPosition(): Vector3;
  protected calculateCameraUpVector(): Vector3 {
    return new Vector3(0, 0, 1);
  };
  protected abstract calculateCameraTargetPosition(): Vector3;

  private updateCamera(): void {
    const pos = this.calculateCameraPosition();
    const tPos = this.calculateCameraTargetPosition();
    const upV = this.calculateCameraUpVector();
    this.camera.position.set(pos.x, pos.y, pos.z);
    this.camera.up = upV;
    this.camera.lookAt(tPos);
    this.cameraPosition.next([pos, tPos, upV]);
    this.scene?.renderOnce();
  }

  get currentCameraPosition(): Vector3 {
    return this.cameraPosition.getValue()[0];
  }

  get currentCameraTargetPosition(): Vector3 {
    return this.cameraPosition.getValue()[1];
  }

  subscribeOnCameraDistance(): Observable<number> {
    return this.cameraPosition
      .asObservable()
      .pipe(
        takeUntil(this.detached),
        map(([ position, targetPosition, rotation ]) => {
          return position.distanceTo(targetPosition);
        }),
        distinctUntilChanged(),
      );
  }

  subscribeOnCameraPosition(): Observable<[ Vector3, Vector3, Vector3 ]> {
    return this.cameraPosition
      .asObservable()
      .pipe(takeUntil(this.detached));
  }

}
