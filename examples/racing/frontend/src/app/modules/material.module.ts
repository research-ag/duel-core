import {NgModule} from '@angular/core';

import {MatTooltipModule} from '@angular/material/tooltip';
import {MatSelectModule} from '@angular/material/select';
import {MatDialogModule} from '@angular/material/dialog';
import {MatDividerModule} from '@angular/material/divider';
import {MatListModule} from '@angular/material/list';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRippleModule } from '@angular/material/core';

const matModules = [
  // MatGridListModule,
  // MatCardModule,
  // MatMenuModule,
  // MatTabsModule,
  MatIconModule,
  MatButtonModule,
  MatToolbarModule,
  // MatSidenavModule,
  MatListModule,
  // MatTableModule,
  // MatPaginatorModule,
  // MatSortModule,
  MatFormFieldModule,
  MatInputModule,
  MatSelectModule,
  MatProgressSpinnerModule,
  // MatCheckboxModule,
  // MatDatepickerModule,
  // MatBottomSheetModule,
  // MatProgressBarModule,
  MatRippleModule,
  // MatBadgeModule,
  MatDialogModule,
  MatTooltipModule,
  MatDividerModule,
];

@NgModule({
  imports: [
    ...matModules
  ],
  exports: [
    ...matModules
  ],
})
export class MaterialModule {
}
