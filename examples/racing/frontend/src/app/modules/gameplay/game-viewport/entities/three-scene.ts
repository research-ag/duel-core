import { Camera, PCFSoftShadowMap, Scene, WebGLRenderer } from 'three';
import { async, BehaviorSubject, Observable, Subject } from 'rxjs';
import { filter, throttleTime } from 'rxjs/operators';
import { Gg3dWorld, Renderer3dEntity } from '@gg-web-engine/core';
import { ThreeCameraComponent, ThreeGgWorld, ThreeSceneComponent, ThreeVisualTypeDocRepo } from '@gg-web-engine/three';
import { ThreeRenderingService } from '../services/three-rendering.service';
import { ViewportService } from '../services/viewport.service';

export type ThreeSceneCanvasOptions = {
  transparent: boolean;
  background: number;
};

// Visual-only world: gg-web-engine manages the Three.js scene/renderer/camera plumbing here.
// Gameplay physics stays in the app's own custom implementation (never touches this world's physicsWorld, which is null).
export class ThreeScene {

  public readonly camera$: BehaviorSubject<Camera | null> = new BehaviorSubject<Camera | null>(null);
  private readonly world: ThreeGgWorld = new Gg3dWorld({
    visualScene: new ThreeSceneComponent(),
    physicsWorld: null,
  });
  private rendererEntity: Renderer3dEntity<ThreeVisualTypeDocRepo> | undefined;
  // typed structurally, not as rxjs's own Subscription: @gg-web-engine/core
  // bundles a separate nested rxjs install, and its Subscription isn't
  // assignable to this app's top-level rxjs Subscription type (TS2322 on a
  // private field) even though both are rxjs 7.8.x.
  private resizeSubscription: { unsubscribe(): void } | undefined;

  private readonly beforeRenderSubject: Subject<void> = new Subject<void>();
  private readonly updateSceneSubject: Subject<void> = new Subject<void>();
  private readonly afterRenderSubject: Subject<void> = new Subject<void>();
  private readonly refreshRequest: Subject<void> = new Subject<void>();

  public readonly renderLoopEnabled$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

  public get scene(): Scene {
    return this.world.visualScene!.nativeScene as Scene;
  }

  public get renderer(): WebGLRenderer | undefined {
    return this.rendererEntity?.renderer.nativeRenderer;
  }

  public renderOnce(): void {
    if (!this.renderLoopEnabled$.getValue()) {
      this.refreshRequest.next();
    }
  }

  public subscribeOnBeforeRendering(): Observable<void> {
    return this.beforeRenderSubject.asObservable();
  }

  public subscribeOnUpdateScene(): Observable<void> {
    return this.updateSceneSubject.asObservable();
  }

  public subscribeOnAfterRendering(): Observable<void> {
    return this.afterRenderSubject.asObservable();
  }

  constructor(
    protected readonly renderingService: ThreeRenderingService,
    protected readonly viewport: ViewportService,
    protected readonly canvasIndex: number,
    protected readonly canvas: HTMLCanvasElement,
    protected readonly options: ThreeSceneCanvasOptions,
  ) {
    this.refreshRequest.asObservable()
      .pipe(
        throttleTime(16, async, {
          leading: true,
          trailing: true
        })
      )
      .subscribe(() => {
        this.renderingService.runRenderMethodOnce(this.canvasIndex, this._renderSceneRoutine.bind(this));
      });
    this.camera$
      .pipe(
        filter((camera): camera is Camera => !!camera),
      )
      .subscribe((camera) => {
        if (this.rendererEntity) {
          // camera never actually gets reassigned in this app, only mutated in place
          return;
        }
        this.rendererEntity = this.world.addRenderer(new ThreeCameraComponent(camera), this.canvas, {
          transparent: this.options.transparent,
          background: this.options.background,
          preserveDrawingBuffer: true,
          // 'fullscreen' is what makes gg-web-engine track window
          // resize/orientationchange itself and call resizeRenderer()
          // (renderer.setSize() + camera aspect) — without it,
          // rendererOptions.size is undefined, which gg-web-engine treats
          // as "never resize", not "keep the size I gave the canvas at
          // creation": the canvas stays at its startup resolution forever,
          // stretched by CSS to the new element size. resizeRenderer()
          // itself never calls render() though, so this alone would fix
          // the aspect ratio but still leave the canvas showing a stale
          // frame — see the rendererSize$ subscription below for that half.
          size: 'fullscreen',
        });
        // pre-gg-web-engine app used PCFSoftShadowMap (display.service.ts); restore it explicitly
        // since the engine's own default isn't guaranteed across versions
        this.rendererEntity.renderer.nativeRenderer.shadowMap.type = PCFSoftShadowMap;
        // engine always clears with alpha=1; transparent overlay canvases need alpha=0 or they'd paint over the layer beneath
        this.rendererEntity.renderer.nativeRenderer.setClearColor(this.options.background, this.options.transparent ? 0 : 1);
        // Force a redraw once gg-web-engine has actually applied a resize
        // (rendererSize$ only fires after resizeRenderer() already ran —
        // see IRendererEntity.onSpawned in @gg-web-engine/core — so this
        // never races the resize itself). Rendering here is on-demand
        // (renderOnce(), throttled — see the refreshRequest pipe above),
        // not a free-running per-frame loop, so nothing else would ever
        // repaint the canvas after a resize that happens while the car is
        // stationary and the camera isn't otherwise moving.
        // Not .pipe()'d with our own rxjs operators on purpose:
        // @gg-web-engine/core bundles its own nested rxjs, and its
        // Observable type isn't structurally assignable to this app's
        // top-level rxjs Observable for .pipe() chaining (TS error
        // TS2345 on Subscriber's protected members) even though both are
        // rxjs 7.8.x — plain .subscribe() is permissive enough to avoid it.
        this.resizeSubscription = this.rendererEntity.rendererSize$.subscribe((size) => {
          if (size) {
            this.renderOnce();
          }
        });
        this.renderOnce();
      });
    this.renderLoopEnabled$.subscribe(value => {
        if (value) {
          this.renderingService.addPermanentRenderMethod(this.canvasIndex, this._renderSceneRoutine.bind(this));
        } else {
          this.renderingService.removePermanentRenderMethod(this.canvasIndex);
        }
    });
  }

  public async init(): Promise<void> {
    await this.world.init();
  }

  private _renderSceneRoutine(): void {
    this.beforeRenderSubject.next();
    this.updateSceneSubject.next();
    if (this.rendererEntity) {
      this.rendererEntity.renderer.render();
    }
    this.afterRenderSubject.next();
  }

}
