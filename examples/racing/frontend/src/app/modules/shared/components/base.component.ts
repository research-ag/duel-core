import {Subject} from 'rxjs';
import { Injectable, OnDestroy } from '@angular/core';

@Injectable()
export default class BaseComponent implements OnDestroy {

  protected destroyed: Subject<void> = new Subject();

  ngOnDestroy(): void {
    this.destroyed.next();
    this.destroyed.unsubscribe();
  }

}
