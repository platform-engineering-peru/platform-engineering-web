/** Editorial line illustrations keyed by subject, stable across filtering and locales. */
export const coverArt = {
 'fundamentals:guide': ['M30 75 120 30 210 75 120 120Z M30 105 120 150 210 105 M30 135 120 180 210 135', 'M120 120v60 M30 75v60 M210 75v60'],
 'fundamentals:course': ['M25 55Q70 35 120 60Q170 35 215 55V165Q170 145 120 170Q70 145 25 165Z M120 60v110', 'M45 75h50 M45 95h50 M45 115h35 M145 75h50 M145 95h50 M145 115h35'],
 'idp:article': ['M40 45h160v120H40Z M40 75h160 M85 45v120', 'M105 95h70v45h-70Z M65 60h1 M120 165v20 M85 185h70'],
 'idp:cage': ['M55 170V65Q120-5 185 65v105 M35 170h170 M80 45v125 M110 30v140 M140 30v140', 'M165 70 210 45v110l-45 20 M175 110h10'],
 'golden-paths:article': ['M35 180V130Q35 105 65 105H165Q195 105 195 75V30', 'M25 160h20 M60 95v20 M105 95v20 M150 95v20 M185 55h20 M180 45l15-15 15 15'],
 'devex:score': ['M35 30v150h175 M60 145v-35h25v35 M105 145V80h25v65 M150 145V45h25v100', 'M55 80l50-25 50-35 M145 20h10v10'],
 'devex:article': ['M35 40h170v115H35Z M35 65h170 M60 85h55v45H60Z M130 85h50 M130 105h35', 'M150 125l15 65 13-24 25-7Z M55 52h1 M68 52h1'],
 'teams:article': ['M120 90a20 20 0 1 0 0-40 20 20 0 0 0 0 40 M85 140q0-40 35-40t35 40Z', 'M50 130a15 15 0 1 0 0-30 15 15 0 0 0 0 30 M25 170q0-30 25-30t25 30Z M190 130a15 15 0 1 0 0-30 15 15 0 0 0 0 30 M165 170q0-30 25-30t25 30Z'],
 'ai:article': ['M75 55h90v90H75Z M95 75h50v50H95Z', 'M90 30v25 M120 30v25 M150 30v25 M90 145v25 M120 145v25 M150 145v25 M50 70h25 M50 100h25 M50 130h25 M165 70h25 M165 100h25 M165 130h25'],
 'career:article': ['M35 180h45v-40h45v-40h45V60h40 M45 115 155 25 M125 25h30v30', 'M35 195h175'],
 'idp:tool': ['M30 35h50v50H30Z M95 35h50v50H95Z M160 35h50v50h-50Z M30 120h50v50H30Z M95 120h50v50H95Z M160 120h50v50h-50Z', 'M55 85v35 M120 85v35 M185 85v35 M80 60h15 M145 60h15 M80 145h15 M145 145h15'],
 'fundamentals:report': ['M45 25h110l40 40v120H45Z M155 25v40h40 M65 150v-30h20v30 M100 150V95h20v55 M135 150V80h20v70', 'M65 50h60 M65 65h45 M65 165h110'],
};
export function coverArtKey(resource: {topic:string;type:string;href:string}): keyof typeof coverArt {
 if(resource.href.includes('golden-cage')) return 'idp:cage';
 if(resource.href.includes('scorecard')) return 'devex:score';
 const key=`${resource.topic}:${resource.type}` as keyof typeof coverArt;
 return key in coverArt ? key : 'fundamentals:guide';
}
