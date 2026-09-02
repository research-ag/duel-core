import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, Renderer2 } from '@angular/core';
import { ViewportService } from '../../services/viewport.service';
import { DisplayService } from '../../services/display.service';

@Component({
    selector: 'app-game-stage',
    templateUrl: './game-stage.component.html',
    styleUrls: ['./game-stage.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
    standalone: false
})
export class GameStageComponent implements AfterViewInit, OnDestroy {

  constructor(
    private readonly viewport: ViewportService,
    private readonly display: DisplayService,
    public readonly elementRef: ElementRef<GameStageComponent>,
    public readonly renderer: Renderer2,
  ) {
  }

  ngAfterViewInit(): void {
    this.display.initDisplay(this);
  }

  ngOnDestroy(): void {
    this.display.disposeDisplay();
  }

}
