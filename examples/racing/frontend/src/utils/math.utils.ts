export default class MathUtils {

  static toRange(value: number, minValue: number, maxValue: number): number {
    return Math.min(Math.max(value, minValue), maxValue);
  }

  static wrapRange(value: number, min: number, max: number): number {
    const maxLessMin = max - min;
    return ((value - min) % maxLessMin + maxLessMin) % maxLessMin + min;
  }

}
