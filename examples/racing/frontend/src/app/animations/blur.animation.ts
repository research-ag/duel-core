import {animate, query, style, transition, trigger} from '@angular/animations';

export const blurAnimation = trigger('blurAnimation', [
  transition('* => *', [
    query(
      ':enter',
      [style({
        filter: 'blur(0.5rem)'
      })
      ],
      { optional: true }
    ),
    query(
      ':leave',
      [
        style(
          {
            filter: 'blur(0rem)'
          }),
        animate('0.3s', style({
          opacity: 0
        })),
      ],
      { optional: true }
    ),
    query(
      ':enter',
      [
        style({
          filter: 'blur(0.5rem)'
        }),
        animate('0.3s', style({
          filter: 'blur(0rem)'
        }))
      ],
      { optional: true }
    )
  ])
]);
