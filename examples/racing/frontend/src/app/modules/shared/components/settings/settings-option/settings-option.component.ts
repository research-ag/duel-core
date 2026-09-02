import { Component, Input, ChangeDetectionStrategy } from '@angular/core';
import { OptionDescriptor } from '../../../models/ls-option-descriptors';
import { LocalStorageService } from '../../../services/local-storage.service';

@Component({
    selector: 'app-settings-option',
    templateUrl: './settings-option.component.html',
    styleUrls: ['./settings-option.component.scss',],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class SettingsOptionComponent {

  constructor(
    public readonly lss: LocalStorageService,
  ) {
  }

  @Input('optionDescriptor')
  optionDescriptor: OptionDescriptor<any> | undefined;

  onValueChange(value: any) {
    if (this.optionDescriptor) {
      this.lss.set(this.optionDescriptor.key, value);
    }
  }

}
