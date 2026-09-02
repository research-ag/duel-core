import {Component, Input, OnInit, ChangeDetectionStrategy} from '@angular/core';
import { LocalStorageService } from '../../../services/local-storage.service';
import { OptionDescriptor } from '../../../models/ls-option-descriptors';

@Component({
    selector: 'app-settings-color-picker',
    templateUrl: './settings-color-picker.component.html',
    styleUrls: ['./settings-color-picker.component.scss',],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class SettingsColorPickerComponent implements OnInit {

  constructor(
    public readonly lss: LocalStorageService,
  ) {
  }

  @Input('optionDescriptor')
  optionDescriptor: OptionDescriptor<string> | undefined;

  ngOnInit() {
  }

  onValueChange(value: string) {
    if (this.optionDescriptor) {
      this.lss.set(this.optionDescriptor.key, value);
    }
  }

}
