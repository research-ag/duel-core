import { Injectable } from '@angular/core';
import { Router } from '@angular/router';
import { BehaviorSubject, Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { HttpService } from './http.service';
import { OwnUserData } from '../interfaces/user.interfaces';
import { CarData } from '../interfaces/car.interfaces';

@Injectable()
export class ApiService {
  currentUser: OwnUserData | null = this.setUserFromLocalStorage();
  isLoadingSomething$: BehaviorSubject<boolean> = new BehaviorSubject<boolean>(false);

  constructor(
    private readonly httpService: HttpService,
    private readonly router: Router,
  ) {
  }

  login(dto: { email: string; password: string; }): Observable<OwnUserData> {
    return this.httpService.apiPost<OwnUserData>('auth/login/', dto)
      .pipe(
        map((user: OwnUserData) => {
          try {
            localStorage.setItem('currentUser', JSON.stringify(user));
          } catch (err) {
            console.warn('LocalStorage unavailable');
          }
          return this.currentUser = user;
        }));
  }

  logout(): void {
    this.currentUser = null;
    try {
      localStorage.removeItem('currentUser');
      this.router.navigate(['login']);
    } catch (err) {
      console.warn('LocalStorage unavailable');
    }
  }

  createUser(dto: {
    login: string,
    password: string,
    firstName: string,
    lastName: string,
    displayName: string,
  }): Observable<OwnUserData> {
    return this.httpService.apiPost<OwnUserData>('auth/register/', dto)
      .pipe(
        map((user: OwnUserData) => {
          try {
            localStorage.setItem('currentUser', JSON.stringify(user));
          } catch (err) {
            console.warn('LocalStorage unavailable');
          }
          return this.currentUser = user;
        }));
  }

  loadCars(): Observable<CarData[]> {
    return this.httpService.apiGet<CarData[]>('car/');
  }

  private setUserFromLocalStorage() {
    try {
      return JSON.parse(localStorage.getItem('currentUser') || 'null');
    } catch (err) {
      console.warn('LocalStorage unavailable');
    }
  }
}
