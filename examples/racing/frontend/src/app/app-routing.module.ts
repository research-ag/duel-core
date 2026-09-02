import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';

const routes: Routes = [
  {
    path: 'menu',
    loadChildren: () => import('./modules/pages/user-menu-page/user-menu-page.module').then(m => m.UserMenuPageModule),
  },
  {
    path: 'game',
    loadChildren: () => import('./modules/pages/in-game-page/in-game-page.module').then(m => m.InGamePageModule),
  },
  {
    path: '',
    loadChildren: () => import('./modules/pages/landing/landing-page.module').then(m => m.LandingPageModule),
  },
  {
    path: '**',
    redirectTo: ''
  }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule {
}
