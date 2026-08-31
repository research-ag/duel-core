import { BufferAttribute, BufferGeometry, Color, ColorRepresentation, Mesh, MeshBasicMaterial, Shape, ShapeGeometry, Vector2 } from 'three';
import StepTrajectoryModel from '../../../../gameplay/models/gameplay/control/step-trajectory.model';
import { GeomUtils } from '../../../../../../../utils/geom.utils';

export default class StepArcDisplayObject extends Mesh {

  private static readonly CURVATURE_SEGMENTS: number = 32;
  private static readonly ACCELERATION_SEGMENTS: number = 16;
  private static readonly OUTER_STROKE_VERTEX_COUNT: number = (StepArcDisplayObject.CURVATURE_SEGMENTS + StepArcDisplayObject.ACCELERATION_SEGMENTS) * 4;
  private static readonly INNER_STROKE_VERTEX_COUNT: number = (StepArcDisplayObject.CURVATURE_SEGMENTS + 1) * 2;
  private static readonly BASE_STROKE_OPACITY: number = 1;
  private static readonly BASE_FILL_OPACITY: number = 0.3;
  // same accent red used elsewhere for "something went wrong" (the minimap
  // finish line, the HUD speedometer needle fill) - see style.css/hud.ts.
  private static readonly CRASH_COLOR: number = 0xe32e00;
  public strokeThickness: number;
  public innerThickness: number;
  private _geometry: BufferGeometry;
  public readonly fillShape: Mesh;
  // the fixed step-control color (see control-scene.service.ts's
  // setColor() call) - remembered so a setSkipped(false) can restore it
  // after setSkipped(true) overrides it to CRASH_COLOR.
  private normalColor: Color = new Color(0x41a3f4);
  private skipped: boolean = false;

  constructor(strokeThickness: number = 0.1, innerThickness: number = 0.04) {
    const geometry = new BufferGeometry();
    // creating vertices
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(
        Array(
          (StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT
            + StepArcDisplayObject.INNER_STROKE_VERTEX_COUNT)
          * 3).fill(0)
      ), 3));
    // creating faces for outer stroke
    const faceIndex = [];
    for (let i = 0; i <= StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT - 3; i += 2) {
      faceIndex.push(i, i + 2, i + 1);
      faceIndex.push(i + 1, i + 2, i + 3);
    }
    faceIndex.push(StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT - 2, 0, StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT - 1);
    faceIndex.push(StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT - 1, 0, 1);
    // creating faces for inner stroke
    for (let i = StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT; i <= StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT + StepArcDisplayObject.INNER_STROKE_VERTEX_COUNT - 3; i += 2) {
      faceIndex.push(i, i + 2, i + 1);
      faceIndex.push(i + 1, i + 2, i + 3);
    }
    geometry.setIndex(faceIndex);
    const material: MeshBasicMaterial = new MeshBasicMaterial({
      color: 0,
      opacity: StepArcDisplayObject.BASE_STROKE_OPACITY,
      transparent: true
    });
    super(geometry, material);
    this._geometry = geometry;
    this.strokeThickness = strokeThickness;
    this.innerThickness = innerThickness;
    this.fillShape = new Mesh(
      new ShapeGeometry(new Shape()),
      new MeshBasicMaterial({
        color: 0x41a3f4,
        opacity: StepArcDisplayObject.BASE_FILL_OPACITY,
        transparent: true
      })
    );
    super.add(this.fillShape);
  }

  // dims the arc to half opacity AND tints it red while a forced (crash-penalty)
  // zero-movement move is auto-submitted and we're waiting on other players;
  // the arc stays visible (as a "why can't I move" cue) but non-interactive.
  setSkipped(skipped: boolean): void {
    this.skipped = skipped;
    (this.material as MeshBasicMaterial).opacity = skipped ?
      StepArcDisplayObject.BASE_STROKE_OPACITY * 0.5 : StepArcDisplayObject.BASE_STROKE_OPACITY;
    (this.fillShape.material as MeshBasicMaterial).opacity = skipped ?
      StepArcDisplayObject.BASE_FILL_OPACITY * 0.5 : StepArcDisplayObject.BASE_FILL_OPACITY;
    this.applyColor(skipped ? StepArcDisplayObject.CRASH_COLOR : this.normalColor);
  }

  // the fixed step-control color (control-scene.service.ts's init() call)
  // - stored rather than applied directly so a currently-skipped arc isn't
  // knocked back to it mid-penalty.
  setColor(color: ColorRepresentation): void {
    this.normalColor.set(color);
    if (!this.skipped) {
      this.applyColor(this.normalColor);
    }
  }

  private applyColor(color: ColorRepresentation): void {
    (this.material as MeshBasicMaterial).color.set(color);
    (this.fillShape.material as MeshBasicMaterial).color.set(color);
  }

  setAreaProperties(minDistance: number, maxDistance: number, momentumDistance: number, maxCurvature: number): void {
    const strokePoints: Vector2[] = this.getStrokePoints(minDistance, maxDistance, maxCurvature);
    const lineAngles: number[] = [];
    for (let i = 0; i < strokePoints.length; i++) {
      lineAngles.push(GeomUtils.getAngleBetweenPoints(strokePoints[i], strokePoints[i === strokePoints.length - 1 ? 0 : i + 1]));
    }
    let lineHalfDeltaAngle: number;
    let perpendicularAngle: number;
    let thickness: number;
    const positions = this._geometry.attributes.position.array;
    for (let i = 0; i < strokePoints.length; i++) {
      lineHalfDeltaAngle = (
        Math.PI -
        GeomUtils.getAnglesDifference(lineAngles[i === 0 ? lineAngles.length - 1 : i - 1], lineAngles[i])
      ) / 2;
      perpendicularAngle = lineAngles[i] + lineHalfDeltaAngle;
      thickness = Math.abs(this.strokeThickness / Math.sin(lineHalfDeltaAngle));
      positions[i * 6] = strokePoints[i].x - thickness * Math.cos(perpendicularAngle) / 2;
      positions[i * 6 + 1] = strokePoints[i].y - thickness * Math.sin(perpendicularAngle) / 2;
      positions[i * 6 + 2] = 0.01;
      positions[i * 6 + 3] = strokePoints[i].x + thickness * Math.cos(perpendicularAngle) / 2;
      positions[i * 6 + 4] = strokePoints[i].y + thickness * Math.sin(perpendicularAngle) / 2;
      positions[i * 6 + 5] = 0.01;
    }
    const innerStrokePoints: Vector2[] = [];
    const curvatureStep: number = maxCurvature * 2 / StepArcDisplayObject.CURVATURE_SEGMENTS;
    for (let i = 0; i <= StepArcDisplayObject.CURVATURE_SEGMENTS; i++) {
      innerStrokePoints.push(new StepTrajectoryModel(momentumDistance, maxCurvature - i * curvatureStep).position);
    }
    for (let i = 0; i <= StepArcDisplayObject.CURVATURE_SEGMENTS; i++) {
      const nearPoint = new StepTrajectoryModel(momentumDistance - this.innerThickness / 2, maxCurvature - i * curvatureStep).position;
      const farPoint = new StepTrajectoryModel(momentumDistance + this.innerThickness / 2, maxCurvature - i * curvatureStep).position;
      positions[StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT * 3 + i * 6] = nearPoint.x;
      positions[StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT * 3 + i * 6 + 1] = nearPoint.y;
      positions[StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT * 3 + i * 6 + 2] = 0.01;
      positions[StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT * 3 + i * 6 + 3] = farPoint.x;
      positions[StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT * 3 + i * 6 + 4] = farPoint.y;
      positions[StepArcDisplayObject.OUTER_STROKE_VERTEX_COUNT * 3 + i * 6 + 5] = 0.01;
    }
    this._geometry.attributes.position.needsUpdate = true;
    this._geometry.computeBoundingBox();
    this._geometry.computeBoundingSphere();
    this.fillShape.geometry.dispose();
    this.fillShape.geometry = new ShapeGeometry(new Shape(strokePoints));
  }

  private getStrokePoints(minDistance: number, maxDistance: number, maxCurvature: number): Vector2[] {
    const strokePoints: Vector2[] = [];
    const accelerationStep: number = (maxDistance - minDistance) / StepArcDisplayObject.ACCELERATION_SEGMENTS;
    const curvatureStep: number = maxCurvature * 2 / StepArcDisplayObject.CURVATURE_SEGMENTS;
    for (let i = 0; i <= StepArcDisplayObject.CURVATURE_SEGMENTS / 2; i++) {
      strokePoints.push(new StepTrajectoryModel(minDistance, i * curvatureStep).position);
    }
    for (let i = 1; i <= StepArcDisplayObject.ACCELERATION_SEGMENTS; i++) {
      strokePoints.push(new StepTrajectoryModel(minDistance + i * accelerationStep, maxCurvature).position);
    }
    for (let i = 1; i <= StepArcDisplayObject.CURVATURE_SEGMENTS; i++) {
      strokePoints.push(new StepTrajectoryModel(maxDistance, maxCurvature - i * curvatureStep).position);
    }
    for (let i = 1; i <= StepArcDisplayObject.ACCELERATION_SEGMENTS; i++) {
      strokePoints.push(new StepTrajectoryModel(maxDistance - i * accelerationStep, -maxCurvature).position);
    }
    for (let i = 1; i < StepArcDisplayObject.CURVATURE_SEGMENTS / 2; i++) {
      strokePoints.push(new StepTrajectoryModel(minDistance, -maxCurvature + i * curvatureStep).position);
    }
    return strokePoints;
  }
}
