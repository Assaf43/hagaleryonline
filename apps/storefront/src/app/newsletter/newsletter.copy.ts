/** Hebrew copy of the newsletter pages and footer form (GEN-04: one file per area). */
export const NEWSLETTER_COPY = {
  formTitle: 'עדכונים ומבצעים',
  emailLabel: 'דוא״ל',
  submit: 'הרשמה',
  honeypotLabel: 'אתר אינטרנט',
  /** The same answer for every accepted request, so nobody learns whether an address is already on the list. */
  sent: 'שלחנו קישור אישור למייל. ההרשמה תושלם אחרי האישור.',
  emailInvalid: 'יש להזין כתובת דוא״ל תקינה',
  consentMissing: 'יש לסמן את ההסכמה כדי להירשם',
  tooMany: 'ביצעתם יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
  failed: 'משהו השתבש. נסו שוב.',

  confirmTitle: 'אישור הרשמה לדיוור',
  confirming: 'מאשרים…',
  confirmed: 'ההרשמה לדיוור אושרה',
  confirmedFor: 'הכתובת שאושרה:',
  linkInvalid: 'הקישור לא תקין או שפג תוקפו. אפשר להירשם שוב מתחתית האתר.',
  retry: 'ניסיון נוסף',
  toHome: 'לדף הבית',

  unsubscribeTitle: 'הסרה מרשימת הדיוור',
  unsubscribeText: 'לחיצה על הכפתור תסיר את הכתובת מרשימת הדיוור.',
  unsubscribeButton: 'הסרה מרשימת הדיוור',
  unsubscribed: 'הוסרתם מרשימת הדיוור',
  unsubscribedText: 'לא נשלח אליכם עוד דיוור שיווקי.',
} as const;
