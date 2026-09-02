import {animate, query, style, transition, trigger} from '@angular/animations';

export const slideAnimation = trigger('slideAnimation', [
  transition('* => *', [
    query(
      ':enter',
      [style({
        transform: 'translateX(-500px)'
      })
      ],
      { optional: true }
    ),
    query(
      ':leave',
      [
        style(
          {
            transform: 'translateX(0px)'
          }),
        animate('0.3s', style({
          transform: 'translateX(500px)'
        })),
      ],
      { optional: true }
    ),
    query(
      ':enter',
      [
        style({
          transform: 'translateX(-500px)'
        }),
        animate('0.3s', style({
          transform: 'translateX(0px)'
        }))
      ],
      { optional: true }
    )
  ])
]);
