import { NgModule } from '@angular/core';

import { AppRoutingModule } from './app-routing.module';
import { ApiModule } from './modules/api/api.module';
import { OfflineHeaderComponent } from './components/offline-header/offline-header.component';
import { AppComponent } from './components/app/app.component';
import { LoaderLayerComponent } from './components/loader-layer/loader-layer.component';
import { RouterModule } from '@angular/router';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { CommonModule } from '@angular/common';
import { MaterialModule } from './modules/material.module';
import { SharedModule } from './modules/shared/shared.module';
import { SettingsPopupComponent } from './components/settings-popup/settings-popup.component';

@NgModule({
    imports: [
        CommonModule,
        RouterModule,
        BrowserAnimationsModule,
        MaterialModule,
        AppRoutingModule,
        ApiModule,
        SharedModule,
    ],
    declarations: [
        AppComponent,
        OfflineHeaderComponent,
        LoaderLayerComponent,
        SettingsPopupComponent,
    ],
    providers: [],
    bootstrap: [AppComponent]
})
export class AppModule {
}
