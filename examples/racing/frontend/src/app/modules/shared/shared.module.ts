import {CommonModule} from '@angular/common';
import {RouterModule} from '@angular/router';
import {FormsModule, ReactiveFormsModule} from '@angular/forms';
import {NgModule} from '@angular/core';
import {MaterialModule} from '../material.module';
import {SettingsComponent} from './components/settings/settings.component';
import {SettingsOptionComponent} from './components/settings/settings-option/settings-option.component';
import {SettingsColorPickerComponent} from './components/settings/settings-color-picker/settings-color-picker.component';
import { LocalStorageService } from './services/local-storage.service';

const sharedComponents = [
  SettingsComponent,
  SettingsOptionComponent,
  SettingsColorPickerComponent,
];

const sharedModules = [
  CommonModule,
  RouterModule,
  FormsModule,
  ReactiveFormsModule,
  MaterialModule,
];

const sharedServices = [
  LocalStorageService,
];

@NgModule({
  declarations: [
    ...sharedComponents,
  ],
  imports: [
    ...sharedModules,
  ],
  exports: [
    ...sharedModules,
    ...sharedComponents,
  ],
  providers: [
    ...sharedServices,
  ]
})
export class SharedModule {
}
