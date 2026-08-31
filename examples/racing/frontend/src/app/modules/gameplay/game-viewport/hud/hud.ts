// Plain-DOM in-race HUD (speedometer / minimap / position+time panel).
// Every GameStateService subject is subscribed directly here and pokes the
// DOM by hand — deliberately simple (a CSS conic-gradient ring for the
// speedometer, no tick-mark/needle math).
//
// Construct once (this is a page-lifetime singleton, same as every other
// service in main.ts) and call mount() once #hud exists in the DOM; the
// panels themselves need no per-race reset — they're pure reflections of
// GameStateService's own subjects, which gameplay.service.ts's startRace()
// already resets (see game-state.service.ts's resetRaceClock() for the
// wall-clock race timer, the one piece of state that lives here).
import { Vector2, Vector3 } from 'three';
import { GameStateService } from '../../game-shared/services/game-state.service';
import RoadSplinePointModel from '../../gameplay/models/gameplay/world/road-spline/road-spline-point.model';
import { GeomUtils } from '../../../../../utils/geom.utils';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAP_SIZE = 200;
const MAX_SPEED = 320; // km/h, speedometer gauge scale

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  return node;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag);
}

export class Hud {

  private readonly root: HTMLDivElement = el('div', 'hud-root');

  // --- race panel (top-left: position/count + time + the two rows) ---
  private readonly raceHeader: HTMLDivElement = el('div', 'hud-race-header');
  private readonly raceTime: HTMLSpanElement = el('span', 'hud-race-time');
  private readonly raceRows: HTMLDivElement = el('div', 'hud-race-rows');

  // --- minimap (bottom-left) ---
  private readonly mapSvg: SVGSVGElement = svgEl('svg');
  private readonly mapTrack: SVGPolylineElement = svgEl('polyline');
  private readonly mapFinish: SVGPolylineElement = svgEl('polyline');
  private readonly mapDots: SVGCircleElement[] = [svgEl('circle'), svgEl('circle')];
  private mapScaling: { x: number, y: number, width: number, height: number } = { x: 0, y: 0, width: 100, height: 100 };

  // --- speedometer (bottom-right) ---
  private readonly speedRing: HTMLDivElement = el('div', 'hud-speed-ring');
  private readonly speedValue: HTMLDivElement = el('div', 'hud-speed-value');

  private raceClockTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly gameStateService: GameStateService) {
    this.buildRacePanel();
    this.buildMinimap();
    this.buildSpeedometer();
    this.wire();
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.root);
  }

  private buildRacePanel(): void {
    const panel = el('div', 'hud-panel hud-race');
    this.raceHeader.append('- / -', this.raceTime);
    panel.append(this.raceHeader, el('hr', 'hud-sep'), this.raceRows);
    this.root.appendChild(panel);
  }

  private buildMinimap(): void {
    const panel = el('div', 'hud-panel hud-minimap');
    this.mapSvg.setAttribute('viewBox', `0 0 ${MAP_SIZE} ${MAP_SIZE}`);
    this.mapTrack.setAttribute('class', 'hud-map-track');
    this.mapFinish.setAttribute('class', 'hud-map-finish');
    this.mapSvg.append(this.mapTrack, this.mapFinish, ...this.mapDots);
    this.mapDots.forEach((dot, slot) => dot.setAttribute('class', `hud-map-car hud-map-car--${slot}`));
    panel.appendChild(this.mapSvg);
    this.root.appendChild(panel);
  }

  private buildSpeedometer(): void {
    const panel = el('div', 'hud-panel hud-speedometer');
    this.speedValue.textContent = '0';
    const unit = el('div', 'hud-speed-unit');
    unit.textContent = 'km/h';
    this.speedRing.append(this.speedValue, unit);
    panel.appendChild(this.speedRing);
    this.root.appendChild(panel);
  }

  private wire(): void {
    this.gameStateService.mapData.subscribe((data) => {
      if (!data) {
        return;
      }
      this.drawTrack(data.roadSpline.points);
    });

    this.gameStateService.cars.subscribe((cars) => {
      // mySlot is always set (see LobbyConnectionService.onStatus) before
      // lobbyData is pushed, which is what derives this cars array — so
      // it's already correct by the time a fresh Car[] shows up here.
      const mySlot = this.gameStateService.mySlot.getValue();
      (cars || []).forEach((car, slot) => {
        if (!car || !this.mapDots[slot]) {
          return;
        }
        car.positionChangedSubject.subscribe((pos) => this.setCarDot(slot, pos));
        if (slot === mySlot) {
          car.speedChangedSubject.subscribe((speed) => this.setSpeed(speed));
        }
      });
    });

    this.gameStateService.playerPositions.subscribe(() => this.renderRaceRows());
    this.gameStateService.runtimeData.subscribe(() => this.renderRaceRows());

    // raceTime is a plain getter (see game-state.service.ts), not an
    // observable — there's no CD loop to piggyback on anymore, so poll it.
    clearInterval(this.raceClockTimer);
    this.raceClockTimer = setInterval(() => this.renderRaceTime(), 100);
  }

  private drawTrack(points: RoadSplinePointModel[]): void {
    const min = new Vector2(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    const max = new Vector2(Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER);
    points.forEach((p) => {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, p.y);
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, p.y);
    });
    const size = new Vector2(max.x - min.x, max.y - min.y);
    this.mapScaling = {
      x: min.x - size.x * 0.1,
      y: min.y - size.y * 0.1,
      width: size.x * 1.2,
      height: size.y * 1.2,
    };

    const toSvg = (p: Vector3): Vector2 => new Vector2(
      (p.x - this.mapScaling.x) * MAP_SIZE / this.mapScaling.width,
      (this.mapScaling.y - p.y) * MAP_SIZE / this.mapScaling.height + MAP_SIZE,
    );
    const drawn = points.map(toSvg);
    this.mapTrack.setAttribute('points', drawn.map((v) => `${Math.round(v.x)},${Math.round(v.y)}`).join(' '));

    if (drawn.length > 1) {
      const angle = (
        GeomUtils.getAngleBetweenPoints(drawn[0], drawn[1]) +
        GeomUtils.getAngleBetweenPoints(drawn[drawn.length - 1], drawn[0])
      ) / 2;
      const half = MAP_SIZE / 20;
      const a = new Vector2(drawn[0].x + half * Math.cos(angle + Math.PI / 2), drawn[0].y + half * Math.sin(angle + Math.PI / 2));
      const b = new Vector2(drawn[0].x - half * Math.cos(angle + Math.PI / 2), drawn[0].y - half * Math.sin(angle + Math.PI / 2));
      this.mapFinish.setAttribute('points', `${Math.round(a.x)},${Math.round(a.y)} ${Math.round(b.x)},${Math.round(b.y)}`);
    }
  }

  private setCarDot(slot: number, pos: Vector2): void {
    const dot = this.mapDots[slot];
    if (!dot) {
      return;
    }
    const x = (pos.x - this.mapScaling.x) * MAP_SIZE / this.mapScaling.width;
    const y = (this.mapScaling.y - pos.y) * MAP_SIZE / this.mapScaling.height + MAP_SIZE;
    dot.setAttribute('cx', String(x));
    dot.setAttribute('cy', String(y));
  }

  private setSpeed(speedMs: number): void {
    const kmh = Math.max(0, speedMs * 3.6);
    this.speedValue.textContent = String(Math.round(kmh));
    const pct = Math.min(1, kmh / MAX_SPEED);
    this.speedRing.style.setProperty('--hud-speed-pct', String(pct));
  }

  private renderRaceRows(): void {
    const positions = this.gameStateService.playerPositions.getValue();
    const runtimeData = this.gameStateService.runtimeData.getValue();
    const mySlot = this.gameStateService.mySlot.getValue();
    const slots = positions ? positions.map((p) => p.slot) : (runtimeData?.players || []).map((p) => p.slot);

    this.raceHeader.firstChild!.textContent =
      `${Math.max(1, slots.indexOf(mySlot) + 1)} / ${slots.length || 2}`;

    this.raceRows.textContent = '';
    slots.forEach((slot, rank) => {
      const row = el('div', 'hud-race-row' + (slot === mySlot ? ' hud-race-row--me' : ''));
      const num = el('span', 'hud-race-row-num');
      num.textContent = String(rank + 1);
      const label = el('span');
      label.textContent = slot === mySlot ? 'You' : 'Opponent';
      row.append(num, label);
      this.raceRows.appendChild(row);
    });
  }

  private renderRaceTime(): void {
    const ms = Math.max(0, this.gameStateService.raceTime);
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const centis = Math.floor((ms % 1000) / 10);
    this.raceTime.textContent =
      `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
  }

}
