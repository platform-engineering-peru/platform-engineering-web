import { pick, type Localized } from '@i18n/utils';
import type { Lang } from '@i18n/config';
import { asset } from '@lib/assets';

export interface Speaker {
  name: string;
  role?: string;
  company?: Localized;
  talk?: Localized;
  photo?: string;
  /** Perfil público (LinkedIn…). */
  url?: string;
}

const same = (text: string): Localized => ({ 'es-pe': text, en: text });

/** Fotos servidas por el CDN de Eventbrite (miniaturas de 294px del lineup). */
const eventbrite = (path: string, query: string) =>
  `https://img.evbuc.com/https%3A%2F%2Fcdn.evbuc.com%2Fimages%2F${path}?h=294&w=294&auto=format%2Ccompress&q=75&sharp=10&${query}`;

/** Speakers de los eventos; `events.ts` los referencia por `name`. */
export const speakers: Speaker[] = [
  // KubeFest #3 — charlas publicadas en Luma; cargo, empresa y foto tomados de LinkedIn (oct. 2026).
  {
    name: 'Danielle Nascimento',
    role: 'Analista de sistemas',
    talk: {
      'es-pe': 'Clústers que piensan: operación inteligente con IA',
      en: 'Clusters that think: AI-driven operations',
    },
    photo: asset('speakers/danielle-nascimento.jpg'),
    url: 'https://www.linkedin.com/in/daniellenascimentodn/',
  },
  {
    name: 'Bianca Torres',
    role: 'DevOps Engineer · AWS Community Builder',
    company: same('Paramo Technologies'),
    talk: {
      'es-pe': 'Escala sin pagar de más: nodos justo a tiempo con Karpenter',
      en: 'Scale without overpaying: just-in-time nodes with Karpenter',
    },
    photo: asset('speakers/bianca-torres.jpg'),
    url: 'https://www.linkedin.com/in/bianca-torres-chumbes/',
  },
  {
    name: 'Michelle Luna',
    role: 'Cloud & DevOps Engineer · AWS Instructor',
    company: same('Whitestack'),
    talk: {
      'es-pe': 'Git como fuente de verdad: despliegues en piloto automático con ArgoCD',
      en: 'Git as the source of truth: autopilot deployments with ArgoCD',
    },
    photo: asset('speakers/michelle-luna.jpg'),
    url: 'https://www.linkedin.com/in/milunadev/',
  },
  {
    name: 'Grecia Vargas',
    role: 'Consultant',
    company: same('OS Enterprise'),
    talk: {
      'es-pe': 'Del contenedor a tu primer clúster',
      en: 'From a container to your first cluster',
    },
    photo: asset('speakers/grecia-vargas.jpg'),
    url: 'https://www.linkedin.com/in/grecia-vargas-rivera-/',
  },
  // KubeFest #02 — lineup y agenda publicados en Eventbrite.
  {
    name: 'Carlos Ortiz',
    role: 'Community leader CNCF · Cloud Engineer',
    talk: same('Comunidades Cloud Native en Perú'),
    photo: eventbrite('1190512544%2F442849417140%2F1%2Foriginal.20260807-012037', 'rect=0%2C0%2C200%2C200&s=3c61061f626ec46a8300efc6962aed83'),
    url: 'https://www.linkedin.com/in/carlos-ortiz-alberca/',
  },
  {
    // Eventbrite los presenta juntos, con una sola foto.
    name: 'Diego Del Castillo & Cristhian Vargas',
    role: 'Architecture DevOps & Cloud',
    talk: same('KubeEdge: procesamiento local y gestión'),
    photo: eventbrite('1190516451%2F442849417140%2F1%2Foriginal.20260807-025142', 'rect=91%2C69%2C255%2C255&s=91218ead3a10764593ea7de8564e2458'),
    // El LinkedIn publicado en Eventbrite (/in/cjvvasquez/) devuelve 404; se omite.
  },
  {
    name: 'Henry Tarazona',
    role: 'Software & AI Agent Engineer',
    company: same('Interbank'),
    talk: same('Un desarrollador Java con superpoderes: Quarkus + OpenShift'),
    photo: eventbrite('1190516559%2F442849417140%2F1%2Foriginal.20260807-025403', 'rect=4%2C14%2C255%2C255&s=ddcc28ffae3f71d3f1ef3a9afce4caaf'),
    url: 'https://www.linkedin.com/in/keniding/',
  },
  {
    name: 'Miguel Villa',
    role: 'OpenShift Specialist & Kubestronaut',
    photo: eventbrite('1190516607%2F442849417140%2F1%2Foriginal.20260807-025455', 's=cfde8326f301ee4edde726168e99a036'),
    url: 'https://www.linkedin.com/in/miguelangelvila/',
  },
  {
    name: 'Jose Luis Buga',
    role: 'Principal Solutions Architect',
    company: same('Red Hat'),
    photo: eventbrite('1190512658%2F442849417140%2F1%2Foriginal.20260807-012333', 'rect=0%2C0%2C400%2C400&s=39ce462fdf6c3acee997c00f1ea20faf'),
    url: 'https://www.linkedin.com/in/joselbugarin/',
  },
  // KubeFest #1 — agenda publicada en CNCF Community Groups (Cloud Native Lima).
  // Carlos Ortiz abrió también esta edición con la misma charla; se reutiliza su entrada.
  {
    name: 'Anthony Mogrovejo',
    role: 'Team Lead Chapter Cloud Networking',
    talk: {
      'es-pe': 'IA generativa, LLMs y RAG desde cero',
      en: 'Generative AI, LLMs and RAG from scratch',
    },
  },
  {
    // La agenda los presenta juntos.
    name: 'Paul Escarcena & Gerson Escarcena',
    role: 'Technology Engineers',
    talk: {
      'es-pe': 'Zero Trust en Kubernetes: del caos al control',
      en: 'Zero Trust on Kubernetes: from chaos to control',
    },
  },
  {
    name: 'Josua Castro',
    role: 'Technology Engineer',
    company: same('Banco de Crédito del Perú'),
    talk: {
      'es-pe': 'Platform Engineering + Crossplane: el futuro del self-service IaC',
      en: 'Platform Engineering + Crossplane: the future of self-service IaC',
    },
    photo: asset('speakers/josua-castro.jpg'),
    url: 'https://www.linkedin.com/in/josuacvga/',
  },
];

export function speakersByName(names: string[]): Speaker[] {
  return names.map((n) => speakers.find((s) => s.name === n)).filter((s): s is Speaker => !!s);
}

/** Props de `SpeakerCard` en el idioma dado. */
export function speakerProps(s: Speaker, lang: Lang) {
  return {
    name: s.name,
    role: s.role,
    company: s.company && pick(s.company, lang),
    talk: s.talk && pick(s.talk, lang),
    photo: s.photo,
    url: s.url,
  };
}
