// A-ASM-1.0 - College Athlete Structured Hydration Assessment, Student-Facing Instrument v1.0 (Document #2).
// Wording and option order are exactly as in Document #2. Hidden point values are from
// Milestone 3 Section 1.4 and are never sent to the athlete's browser.
import type { AssessmentContent, AssessmentItem, ItemOption } from './types';

/** Scored options: points follow the listed order 0, 1, 2, ... */
function scored(labels: string[], extra?: { na?: string; preferNot?: string }): ItemOption[] {
  const opts: ItemOption[] = labels.map((label, i) => ({ code: String(i), label, points: i, kind: 'value' }));
  if (extra?.na) opts.push({ code: 'NA', label: extra.na, points: null, kind: 'na' });
  if (extra?.preferNot) opts.push({ code: 'PNA', label: extra.preferNot, points: null, kind: 'prefer_not' });
  return opts;
}

/** Unscored options with explicit codes. */
function unscored(pairs: [string, string][], noneCode?: string): ItemOption[] {
  return pairs.map(([code, label]) => ({
    code,
    label,
    points: null,
    kind: code === noneCode ? 'none_of_these' : 'value',
  }));
}

type Base = Pick<AssessmentItem, 'itemCode' | 'construct' | 'part' | 'category' | 'prompt' | 'options'>;

const req = (b: Base, type: AssessmentItem['type'] = 'scored'): AssessmentItem => ({
  ...b,
  type,
  required: true,
  naAllowed: b.options.some((o) => o.kind === 'na'),
  optional: false,
  multiSelect: false,
});

const followUp = (b: Base, multiSelect = false): AssessmentItem => ({
  ...b,
  type: 'context',
  required: false,
  naAllowed: false,
  optional: false,
  multiSelect,
});

const c7 = (b: Base): AssessmentItem => ({
  ...b,
  type: 'contextual',
  required: false,
  naAllowed: false,
  optional: true,
  multiSelect: false,
});

const NEVER_CONSISTENTLY = ['Never', 'Sometimes', 'Usually', 'Consistently'];
const SYMPTOM_FREQ = ['Often', 'Sometimes', 'Rarely or never'];
const RARELY_CONSISTENTLY = ['Rarely or never', 'Sometimes', 'Usually', 'Consistently'];
const PNA = 'Prefer not to answer';

const items: AssessmentItem[] = [
  // Part 1 - Lifestyle & Circadian Hydration Behavior
  req({ itemCode: 'Q1', construct: 'C1Q1', part: 1, category: 'C1',
    prompt: 'After waking for the day, how soon do you usually begin drinking water or another hydrating fluid?',
    options: scored(['More than 2 hours', '91-120 minutes', '61-90 minutes', '31-60 minutes', 'Within 30 minutes']) }),
  req({ itemCode: 'Q2', construct: 'C1Q2', part: 1, category: 'C1',
    prompt: 'During classes, labs, work, study periods, or other daytime activities, how consistently do you drink fluids as part of your hydration routine?',
    options: scored(['Rarely', 'Occasionally', 'About half the time', 'Usually', 'Consistently']) }),
  req({ itemCode: 'Q3', construct: 'C1Q3', part: 1, category: 'C1',
    prompt: 'How consistently do you plan when you will have opportunities to hydrate across your day - for example, around classes, work, meals, practices, and other regular activities?',
    options: scored(['I generally do not plan hydration opportunities', 'Rarely', 'Sometimes', 'Usually', 'I consistently plan hydration opportunities across my day']) }),
  req({ itemCode: 'Q4', construct: 'C1Q4', part: 1, category: 'C1',
    prompt: 'If you realize later in the day that you have not been drinking as consistently as you intended, how often do you adjust your hydration earlier in the evening rather than waiting until bedtime?',
    options: scored(['Never', 'Rarely', 'Sometimes', 'Usually', 'Consistently']) }),
  req({ itemCode: 'Q5', construct: 'C1Q5', part: 1, category: 'C1',
    prompt: 'When your normal schedule changes - for example, on weekends, travel days, competition days, or unusually busy days - how consistently do you adjust your hydration routine?',
    options: scored(['I usually lose my hydration routine', 'I often struggle to adjust', 'Sometimes', 'I usually adjust', 'I consistently adapt my hydration routine']) }),

  // Part 2 - Water Access & Environmental Barriers
  req({ itemCode: 'Q6', construct: 'C2Q1', part: 2, category: 'C2',
    prompt: 'Where you spend most of your day on campus, how reliably can you access a working water fountain, refill station, or other source of safe drinking water?',
    options: scored(['Very difficult / rarely available', 'Available but inconvenient or unreliable', 'Usually available and working', 'Readily available and reliably working']) }),
  req({ itemCode: 'Q7', construct: 'C2Q2', part: 2, category: 'C2',
    prompt: 'How much do the location or operating hours of campus facilities interfere with your ability to get drinking water when you need it?',
    options: scored(['Major barrier', 'Moderate barrier', 'Minor barrier', 'Not a barrier']) }),
  req({ itemCode: 'Q8', construct: 'C2Q3', part: 2, category: 'C2',
    prompt: 'During a typical day, how consistently does your class, practice, training, work, or travel schedule give you reasonable opportunities to drink fluids when needed?',
    options: scored(['Rarely or never', 'Sometimes', 'Usually', 'Consistently']) }),
  req({ itemCode: 'Q9', construct: 'C2Q4', part: 2, category: 'C2',
    prompt: 'To what extent do cost, not having a reusable bottle or container, or similar resource needs make it harder for you to keep drinking water available throughout your day?',
    options: scored(['Major barrier', 'Moderate barrier', 'Minor barrier', 'Not a barrier']) }),
  req({ itemCode: 'Q10', construct: 'C2Q5', part: 2, category: 'C2',
    prompt: 'As you move between your residence or commuter route, classes, athletic facilities, practices, and other regular activities, how consistently can you access drinking water or refill your container?',
    options: scored(['Rarely', 'Sometimes', 'Usually', 'Consistently']) }),

  // Part 3 - Exertion & Hydration Management
  req({ itemCode: 'Q11A', construct: 'EXP1', part: 3, category: 'EXP',
    prompt: 'During a typical week, approximately how many hours do you spend in organized practice, training, competition, conditioning, rehearsal, or other strenuous physical activity?',
    options: unscored([['0', '0'], ['1-4', '1-4'], ['5-9', '5-9'], ['10-14', '10-14'], ['15+', '15+']]) }, 'context'),
  req({ itemCode: 'Q11B', construct: 'EXP2', part: 3, category: 'EXP',
    prompt: 'During a typical week, approximately how many hours of your physical activity involve heat or humidity, direct sun, hot indoor conditions, or wearing uniforms/protective equipment that may increase heat load?',
    options: unscored([['none', 'None'], ['lt2', 'Less than 2'], ['2-5', '2-5'], ['6-9', '6-9'], ['10+', '10+']]) }, 'context'),
  req({ itemCode: 'Q12', construct: 'C3Q1', part: 3, category: 'C3',
    prompt: 'Before strenuous training, practice, competition, or other demanding physical activity, how consistently do you think about your hydration needs and make a plan?',
    options: scored(NEVER_CONSISTENTLY) }),
  req({ itemCode: 'Q13', construct: 'C3Q2', part: 3, category: 'C3',
    prompt: 'During prolonged, intense, or physically demanding activity, how consistently do you use the hydration opportunities available to you?',
    options: scored(NEVER_CONSISTENTLY) }),
  req({ itemCode: 'Q14', construct: 'C3Q3', part: 3, category: 'C3',
    prompt: 'After strenuous activity or heavy sweating, how consistently do you think about your fluid losses and adjust what you drink during recovery?',
    options: scored(NEVER_CONSISTENTLY) }),
  req({ itemCode: 'Q15A', construct: 'C3Q4A', part: 3, category: 'C3',
    prompt: 'How familiar are you with the hydration and heat-safety procedures for your team or athletic program?',
    options: scored(['I am not familiar with them', 'I know a little about them', 'I am familiar with most of them', 'I am very familiar with them']) }, 'component'),
  req({ itemCode: 'Q15B', construct: 'C3Q4B', part: 3, category: 'C3',
    prompt: 'When those procedures apply, how consistently do you follow them?',
    options: scored(['Rarely or never', 'Sometimes', 'Usually', 'Consistently']) }, 'component'),
  req({ itemCode: 'Q16', construct: 'C3Q5', part: 3, category: 'C3',
    prompt: 'If you experience unusual symptoms or warning signs during heat or strenuous activity, how likely are you to stop or modify the activity and seek appropriate assistance?',
    options: scored(['Very unlikely', 'Somewhat unlikely', 'Somewhat likely', 'Very likely']) }),
  followUp({ itemCode: 'Q16A', construct: 'C3Q5F', part: 3, category: 'C3',
    prompt: 'Do you know whom to contact or what procedure to follow if this happens?',
    options: unscored([['yes', 'Yes'], ['no', 'No'], ['not_sure', 'Not sure']]) }),

  // Part 4 - Hydration Stressors & Adaptive Response
  req({ itemCode: 'Q17', construct: 'C4Q1', part: 4, category: 'C4',
    prompt: 'When you are exposed to heat, humidity, direct sun, or hot indoor conditions, how consistently do you adjust your hydration plan for those conditions?',
    options: scored(['I generally do not adjust', 'Sometimes', 'Usually', 'Consistently']) }),
  req({ itemCode: 'Q18', construct: 'C4Q2', part: 4, category: 'C4',
    prompt: 'If you consume caffeinated beverages or products, how consistently do you consider them as part of your overall fluid intake and hydration planning?',
    options: scored(['I generally do not consider them', 'Sometimes', 'Usually', 'Consistently'], { na: 'I do not consume caffeinated beverages or products' }) }),
  req({ itemCode: 'Q19', construct: 'C4Q3', part: 4, category: 'C4',
    prompt: 'If you consume alcohol, how consistently do you consider its potential effect on your hydration and recovery when making hydration decisions?',
    options: scored(['I generally do not consider it', 'Sometimes', 'Usually', 'Consistently'], { na: 'I do not consume alcohol' }) }),
  req({ itemCode: 'Q20', construct: 'C4Q4', part: 4, category: 'C4',
    prompt: 'When you have an illness with symptoms such as fever, vomiting, or diarrhea, how consistently do you reconsider your hydration needs and follow appropriate health or sports-medicine guidance?',
    options: scored(['I generally do not reconsider', 'Sometimes', 'Usually', 'Consistently, and I follow appropriate guidance'], { na: 'I have not experienced this recently' }) }),
  req({ itemCode: 'Q21', construct: 'C4Q5', part: 4, category: 'C4',
    prompt: 'When travel, long drives or flights, time-zone changes, or unusually long days disrupt your normal routine, how consistently do you adjust your hydration plan?',
    options: scored(['I generally do not adjust', 'Sometimes', 'Usually', 'Consistently'], { na: 'No recent travel or routine disruption' }) }),
  req({ itemCode: 'Q22', construct: 'C4Q6', part: 4, category: 'C4',
    prompt: 'If a qualified health professional has told you that a medication, health condition, or other physiological factor may affect your fluid needs, how consistently do you consider that guidance when making hydration decisions?',
    options: scored(['I generally do not consider it', 'Sometimes', 'Usually', 'Consistently'], { na: 'Does not apply / I have not received such guidance' }) }),

  // Part 5 - Hydration Knowledge & Decision-Making
  req({ itemCode: 'Q23', construct: 'C5Q1', part: 5, category: 'C5',
    prompt: 'How well do you understand that your hydration needs can change throughout the day and from one day to another?',
    options: scored(['I do not yet understand this', 'I have some understanding', 'I understand it fairly well', 'I understand it well and consider it in my decisions']) }),
  req({ itemCode: 'Q24', construct: 'C5Q2', part: 5, category: 'C5',
    prompt: 'How well do you understand that activity, sweating, environmental conditions, recovery needs, and changes in your routine can affect how you approach hydration?',
    options: scored(['I have little or no understanding', 'I understand some of these factors', 'I understand most of these factors', 'I understand them and consider them in my decisions']) }),
  req({ itemCode: 'Q25', construct: 'C5Q3', part: 5, category: 'C5',
    prompt: 'How well do you understand that water may be enough in many situations, while some activities, conditions, or individual needs may require consideration of electrolytes, carbohydrates, or other hydration support?',
    options: scored(['I do not understand this yet', 'I have limited understanding', 'I generally understand this', 'I understand this and know when to seek or follow individualized guidance']) }),
  req({ itemCode: 'Q26', construct: 'C5Q4', part: 5, category: 'C5',
    prompt: 'How well do you understand when changes in how you feel or perform should lead you to reconsider your hydration approach or seek appropriate assistance?',
    options: scored(['I am generally unsure', 'I recognize some situations but am unsure what to do', 'I usually recognize when I should reconsider or seek help', 'I understand when to reassess my approach or seek appropriate assistance']) }),
  req({ itemCode: 'Q27', construct: 'C5Q5', part: 5, category: 'C5',
    prompt: 'How well do you understand that some hydration situations should be discussed with an athletic trainer, sports-medicine professional, or other qualified health professional rather than managed on your own?',
    options: scored(['I am generally unsure', 'I recognize a few situations', 'I usually understand when professional guidance is appropriate', 'I understand the limits of self-management and when to seek guidance']) }),

  // Part 6 - Self-Reported Experiences
  req({ itemCode: 'Q28', construct: 'C6Q1', part: 6, category: 'C6',
    prompt: 'During or after physical activity, how often do you experience unusual fatigue that seems greater than you would normally expect for the activity?',
    options: scored(SYMPTOM_FREQ) }),
  req({ itemCode: 'Q29', construct: 'C6Q2', part: 6, category: 'C6',
    prompt: 'During demanding days or around physical activity, how often do you experience headaches?',
    options: scored(SYMPTOM_FREQ) }),
  req({ itemCode: 'Q30', construct: 'C6Q3', part: 6, category: 'C6',
    prompt: 'During demanding days or around physical activity, how often do you experience unusual difficulty concentrating or maintaining focus?',
    options: scored(SYMPTOM_FREQ) }),
  req({ itemCode: 'Q31', construct: 'C6Q4', part: 6, category: 'C6',
    prompt: 'During or after physical activity, how often do you experience nausea, stomach discomfort, or other digestive upset?',
    options: scored(SYMPTOM_FREQ) }),
  req({ itemCode: 'Q32', construct: 'C6Q5', part: 6, category: 'C6',
    prompt: 'During or after physical activity, how often do you experience one or more of the physical warning symptoms listed below?',
    options: scored(SYMPTOM_FREQ) }),
  followUp({ itemCode: 'Q32A', construct: 'C6D', part: 6, category: 'C6',
    prompt: 'Which of these have you experienced during or after physical activity? Select all that apply.',
    options: unscored([['cramping', 'Muscle cramping'], ['weakness', 'Unusual weakness'], ['dizziness', 'Dizziness'], ['faint', 'Feeling faint'], ['none', 'None of these']], 'none') }, true),
  followUp({ itemCode: 'Q32B', construct: 'C6F', part: 6, category: 'C6',
    prompt: 'If applicable, did you stop or modify the activity or seek assistance when this occurred?',
    options: unscored([['yes', 'Yes'], ['no', 'No'], ['not_sure', 'Not sure or do not remember'], ['na', 'Not applicable']]) }),

  // Part 7 - Hair Care, Physical Activity & Hydration Access (optional, contextual)
  c7({ itemCode: 'Q33', construct: 'C7Q1', part: 7, category: 'C7',
    prompt: 'How often do concerns about sweat, humidity, water, or the effect of physical activity on your hair or hairstyle cause you to skip, shorten, or change physical activity? (Optional)',
    options: scored(SYMPTOM_FREQ, { preferNot: PNA }) }),
  c7({ itemCode: 'Q34', construct: 'C7Q2', part: 7, category: 'C7',
    prompt: 'Do you have access to hair-care options or strategies that help you manage the effects of sweat, humidity, or physical activity on your hair? (Optional)',
    options: scored(['No / very limited access', 'Some access', 'Adequate access'], { preferNot: PNA }) }),
  c7({ itemCode: 'Q35', construct: 'C7Q3', part: 7, category: 'C7',
    prompt: 'How well does your current hair-care approach support the level of physical activity in which you want or need to participate? (Optional)',
    options: scored(['It significantly limits my activity', 'It sometimes limits my activity', 'It supports my preferred level of activity'], { preferNot: PNA }) }),
  c7({ itemCode: 'Q36', construct: 'C7Q4', part: 7, category: 'C7',
    prompt: 'If hair-care concerns were affecting your physical activity or athletic participation, how comfortable would you feel discussing them with an appropriate athletics, wellness, or health-support professional? (Optional)',
    options: scored(['Not comfortable', 'Somewhat comfortable', 'Comfortable'], { preferNot: PNA }) }),
  c7({ itemCode: 'Q37', construct: 'C7Q5', part: 7, category: 'C7',
    prompt: 'How well do campus or athletic facilities, schedules, and available resources support your hair-care needs related to training, competition, or other physical activity? (Optional)',
    options: scored(['They do not adequately support my needs', 'They provide some support', 'They adequately support my needs'], { preferNot: PNA }) }),

  // Part 8 - Hydration Self-Monitoring & Decision Behavior
  req({ itemCode: 'Q38', construct: 'C8Q1', part: 8, category: 'C8',
    prompt: 'How consistently do you pay attention to changes in thirst and how your body feels when deciding whether you may need to reconsider your hydration?',
    options: scored(RARELY_CONSISTENTLY) }),
  req({ itemCode: 'Q39', construct: 'C8Q2', part: 8, category: 'C8',
    prompt: 'During or after demanding physical activity, how consistently do you pay attention to whether your sweating seems different from what is normal for you?',
    options: scored(RARELY_CONSISTENTLY) }),
  req({ itemCode: 'Q40', construct: 'C8Q3', part: 8, category: 'C8',
    prompt: 'After demanding physical activity, how consistently do you think about whether your hydration plan worked well and whether you should change anything next time?',
    options: scored(RARELY_CONSISTENTLY) }),
  req({ itemCode: 'Q41', construct: 'C8Q4', part: 8, category: 'C8',
    prompt: 'When a hydration plan does not seem to work well for you, how consistently do you use that experience to change your plan for future activity or similar conditions?',
    options: scored(RARELY_CONSISTENTLY) }),
  req({ itemCode: 'Q42', construct: 'C8Q5', part: 8, category: 'C8',
    prompt: 'When you are unsure how to adjust your hydration for changing circumstances, how consistently do you seek reliable information or appropriate guidance?',
    options: scored(RARELY_CONSISTENTLY) }),
];

export const A_ASM_1_0: AssessmentContent = {
  title: 'College Athlete Structured Hydration Assessment',
  introduction:
    'This questionnaire is designed to understand hydration routines, access, physical-activity demands, adaptive behavior, knowledge, self-reported experiences, and self-monitoring. There are no right or wrong answers. Please answer based on your usual experience. This instrument does not provide a medical diagnosis.',
  parts: [
    { part: 1, title: 'Lifestyle & Circadian Hydration Behavior' },
    { part: 2, title: 'Water Access & Environmental Barriers' },
    { part: 3, title: 'Exertion & Hydration Management' },
    { part: 4, title: 'Hydration Stressors & Adaptive Response' },
    { part: 5, title: 'Hydration Knowledge & Decision-Making' },
    { part: 6, title: 'Self-Reported Experiences' },
    {
      part: 7,
      title: 'Hair Care, Physical Activity & Hydration Access',
      note: 'This section is optional. You may choose Prefer not to answer. These questions are intended to understand whether hair-care considerations affect participation or access to supportive resources; they are not intended to judge hair type or hairstyle.',
    },
    { part: 8, title: 'Hydration Self-Monitoring & Decision Behavior' },
  ],
  items,
  // Document #2 says "Hydration Intelligence Assessment"; "Structured Hydration Assessment" is used per the
  // terminology rule until WeCanH2O confirms (hand-off open item 6).
  closingStatement:
    "Thank you for completing the Structured Hydration Assessment. Your responses will be interpreted according to the approved program process. If you are experiencing symptoms or have health concerns, follow your institution's approved athletic-training, sports-medicine, or health-support procedures.",
};
