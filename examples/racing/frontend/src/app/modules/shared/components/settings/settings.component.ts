import {Component, ChangeDetectionStrategy} from '@angular/core';
import { LsOptionRepository } from '../../models/ls-option-descriptors';

@Component({
    selector: 'app-settings',
    templateUrl: './settings.component.html',
    styleUrls: ['./settings.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class SettingsComponent {

  LsOptionRepository = LsOptionRepository;

  constructor() {
  }
}
