import { BehaviorSubject, fromEvent, merge, Observable, Subject } from 'rxjs';
import { distinctUntilChanged, map } from 'rxjs/operators';

type Point = { x: number, y: number };

const getCurrentWindowSize = (): Point => {
  return {
    x: window.innerWidth,
    y: window.innerHeight,
  };
}

const getMousePositionFromEvent = (event: MouseEvent | TouchEvent): Point | null => {
  if (event instanceof MouseEvent) {
    return { x: event.x, y: event.y };
  } else if (event instanceof TouchEvent) {
    if (event.touches.length === 0) {
      return null;
    }
    return { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }
  console.warn('Cannot determine mouse position from event', event);
  return null;
}

export class ViewportService {
  // ================================================== VIEWPORT SIZE ==================================================
  private viewportSize: BehaviorSubject<Point> = new BehaviorSubject<Point>(getCurrentWindowSize());
  getCurrentViewportSize(): Point {
    return this.viewportSize.getValue();
  }

  subscribeOnViewportSize(): Observable<Point> {
    return this.viewportSize
      .asObservable()
      .pipe(
        distinctUntilChanged((v1, v2) => {
          return v1.x === v2.x && v1.y === v2.y;
        })
      );
  }
  // ================================================== VIEWPORT SIZE ==================================================


  // ================================================== POINTER LOGIC ==================================================
  private mousePosition: BehaviorSubject<Point> = new BehaviorSubject<Point>({ x: 0, y: 0 });
  private mouseClicked: Subject<Point> = new Subject<Point>();
  private isMouseDown: Subject<boolean> = new Subject<boolean>();

  isMouseEnabled(): boolean {
    return matchMedia('(hover:hover)').matches && matchMedia('(pointer:fine)').matches;
  }

  subscribeOnMouseMove(): Observable<Point> {
    return this.mousePosition
      .asObservable()
      .pipe(
        distinctUntilChanged((v1, v2) => {
          return v1.x === v2.x && v1.y === v2.y;
        })
      );
  }

  subscribeOnIsMouseDown(): Observable<boolean> {
    return this.isMouseDown
      .asObservable()
      .pipe(
        distinctUntilChanged(),
      );
  }

  subscribeOnMouseClick(): Observable<Point> {
    return this.mouseClicked.asObservable();
  }
  // ================================================== POINTER LOGIC ==================================================


  // ================================================ INNER LOGIC BELOW ================================================

  constructor() {
    // cursor position
    merge(
      fromEvent(window, 'mousemove'),
      fromEvent(window, 'touchstart'),
      fromEvent(window, 'touchmove'),
    ).pipe(
      map(event => event as MouseEvent | TouchEvent)
    ).subscribe((event) => {
      const point = getMousePositionFromEvent(event);
      if (point) {
        this.mousePosition.next(point);
      }
    });
    // clicks
    merge(
      fromEvent(window, 'mousedown'),
      fromEvent(window, 'touchstart'),
    ).pipe(
      map(event => event as MouseEvent | TouchEvent)
    ).subscribe((event) => {
      const point = getMousePositionFromEvent(event);
      if (point) {
        this.mousePosition.next(point);
      }
      this.isMouseDown.next(true);
    });
    merge(
      fromEvent(window, 'mouseup'),
      fromEvent(window, 'click'),
      fromEvent(window, 'touchend'),
    ).pipe(
      map(event => event as MouseEvent | TouchEvent)
    ).subscribe((event) => {
      const point = getMousePositionFromEvent(event);
      if (point) {
        this.mousePosition.next(point);
      }
      this.isMouseDown.next(false);
      // TODO check it: add some button over canvas and check that it does not react to it
      if (event.target instanceof HTMLCanvasElement) {
        this.mouseClicked.next(this.mousePosition.getValue());
      }
    });
    // viewport size
    merge(
      fromEvent(window, 'resize'),
      fromEvent(window, 'orientationchange'),
    ).pipe(
      map(() => getCurrentWindowSize()),
    ).subscribe(this.viewportSize);
  }

}
