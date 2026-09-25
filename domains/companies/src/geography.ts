import { normalizeText } from './text.js';

/**
 * Dutch geography for the first version: the country, its twelve provinces, and a maintained list of places with the
 * province they are in. Deliberately no inference beyond that: a place is in one province; a company established in
 * Rotterdam is NOT thereby active in all of Zuid-Holland; a .nl domain says nothing about where a company is. Other
 * countries can be added as another `CountryGeography` without changing the callers.
 */
export interface Province { id: string; name: string; aliases: string[] }
export interface Place { name: string; province: string; aliases?: string[] }
export interface CountryGeography { code: string; name: string; aliases: string[]; provinces: Province[]; places: Place[] }

const PROVINCES: Province[] = [
  { id: 'NL-DR', name: 'Drenthe', aliases: [] },
  { id: 'NL-FL', name: 'Flevoland', aliases: [] },
  { id: 'NL-FR', name: 'Friesland', aliases: ['Fryslân', 'Fryslan'] },
  { id: 'NL-GE', name: 'Gelderland', aliases: [] },
  { id: 'NL-GR', name: 'Groningen (provincie)', aliases: ['provincie Groningen'] },
  { id: 'NL-LI', name: 'Limburg', aliases: [] },
  { id: 'NL-NB', name: 'Noord-Brabant', aliases: ['Noord Brabant', 'Brabant'] },
  { id: 'NL-NH', name: 'Noord-Holland', aliases: ['Noord Holland'] },
  { id: 'NL-OV', name: 'Overijssel', aliases: [] },
  { id: 'NL-UT', name: 'Utrecht (provincie)', aliases: ['provincie Utrecht'] },
  { id: 'NL-ZE', name: 'Zeeland', aliases: [] },
  { id: 'NL-ZH', name: 'Zuid-Holland', aliases: ['Zuid Holland'] },
];

const p = (province: string, names: string) => names.split(',').map(entry => {
  const [name, ...aliases] = entry.split('|').map(part => part.trim());
  return { name, province, ...(aliases.length ? { aliases } : {}) };
});

const PLACES: Place[] = [
  ...p('NL-ZH', "Den Haag|'s-Gravenhage|s-Gravenhage|The Hague,Rotterdam,Leiden,Delft,Dordrecht,Zoetermeer,Gouda,Alphen aan den Rijn,Schiedam,Vlaardingen,Spijkenisse,Westland|Naaldwijk|Monster|Wateringen|'s-Gravenzande,Rijswijk,Leidschendam|Voorburg|Leidschendam-Voorburg,Capelle aan den IJssel,Maassluis,Barendrecht,Ridderkerk,Katwijk,Noordwijk,Wassenaar,Pijnacker|Nootdorp|Pijnacker-Nootdorp,Lansingerland|Berkel en Rodenrijs|Bleiswijk|Bergschenhoek,Gorinchem,Papendrecht,Zwijndrecht,Hellevoetsluis,Leiderdorp,Oegstgeest,Voorschoten,Krimpen aan den IJssel,Hendrik-Ido-Ambacht,Waddinxveen,Bodegraven,Sliedrecht,Lisse,Hillegom,Teylingen|Sassenheim|Voorhout,Midden-Delfland|Maasland,Brielle,Goeree-Overflakkee|Middelharnis,Nissewaard,Hoeksche Waard|Oud-Beijerland,Albrandswaard,Zuidplas|Nieuwerkerk aan den IJssel,Molenlanden,Alblasserdam,Zederik"),
  ...p('NL-NH', 'Amsterdam,Haarlem,Zaanstad|Zaandam,Haarlemmermeer|Hoofddorp|Schiphol,Alkmaar,Hilversum,Amstelveen,Purmerend,Hoorn,Den Helder,Velsen|IJmuiden,Heerhugowaard|Dijk en Waard,Beverwijk,Heemskerk,Castricum,Bussum|Gooise Meren|Naarden,Diemen,Uithoorn,Aalsmeer,Enkhuizen,Edam-Volendam,Heemstede,Bloemendaal,Weesp,Laren,Huizen,Ouder-Amstel,Wormerland,Medemblik,Schagen'),
  ...p('NL-UT', 'Utrecht,Amersfoort,Nieuwegein,Veenendaal,Zeist,Houten,IJsselstein,Woerden,Soest,De Bilt|Bilthoven,Leusden,Stichtse Vecht|Maarssen,Baarn,Vianen,Wijk bij Duurstede,Montfoort,Lopik,Bunnik,Utrechtse Heuvelrug|Doorn|Driebergen,Rhenen,Woudenberg,Renswoude'),
  ...p('NL-NB', "Eindhoven,Tilburg,Breda,'s-Hertogenbosch|Den Bosch|s-Hertogenbosch,Helmond,Oss,Roosendaal,Bergen op Zoom,Waalwijk,Oosterhout,Veldhoven,Uden,Meierijstad|Veghel|Schijndel,Etten-Leur,Best,Boxtel,Vught,Valkenswaard,Geldrop|Geldrop-Mierlo,Nuenen,Son en Breugel,Oisterwijk,Dongen,Goirle,Drunen|Heusden,Waalre,Deurne,Asten,Someren,Cuijk|Land van Cuijk,Boxmeer,Rosmalen,Moerdijk,Zundert,Rucphen,Halderberge,Steenbergen,Woensdrecht,Gemert|Gemert-Bakel,Laarbeek,Bernheze,Sint-Michielsgestel,Oirschot,Bladel,Eersel,Bergeijk,Reusel,Cranendonck,Heeze|Heeze-Leende,Loon op Zand,Kaatsheuvel,Altena|Werkendam,Geertruidenberg,Drimmelen,Hilvarenbeek"),
  ...p('NL-GE', 'Arnhem,Nijmegen,Apeldoorn,Ede,Doetinchem,Harderwijk,Zutphen,Tiel,Wageningen,Barneveld,Culemborg,Winterswijk,Nijkerk,Zevenaar,Duiven,Elst|Overbetuwe,Lingewaard|Huissen|Bemmel,Ermelo,Putten,Epe,Voorst,Lochem,Oude IJsselstreek,Montferland,Berkelland,Oost Gelre,Aalten,Buren,Neder-Betuwe,West Betuwe,Maasdriel,Zaltbommel,Wijchen,Beuningen,Druten,Heumen,Berg en Dal,Renkum,Rheden,Rozendaal,Scherpenzeel,Elburg,Hattem,Heerde,Oldebroek,Brummen,Bronckhorst'),
  ...p('NL-OV', 'Zwolle,Enschede,Deventer,Hengelo,Almelo,Kampen,Oldenzaal,Hardenberg,Rijssen|Rijssen-Holten,Nijverdal|Hellendoorn,Raalte,Steenwijk|Steenwijkerland,Haaksbergen,Borne,Losser,Twenterand,Wierden,Hof van Twente|Goor,Tubbergen,Dinkelland,Olst-Wijhe,Dalfsen,Ommen,Staphorst,Zwartewaterland'),
  ...p('NL-LI', 'Maastricht,Venlo,Heerlen,Sittard|Sittard-Geleen|Geleen,Roermond,Weert,Kerkrade,Venray,Landgraaf,Brunssum,Stein,Echt|Echt-Susteren,Meerssen,Valkenburg,Gennep,Horst|Horst aan de Maas,Peel en Maas|Panningen,Nederweert,Leudal,Maasgouw,Beek,Eijsden|Eijsden-Margraten,Gulpen|Gulpen-Wittem,Vaals,Simpelveld,Voerendaal,Bergen (L),Beesel,Roerdalen,Mook'),
  ...p('NL-GR', 'Groningen,Veendam,Hoogezand|Midden-Groningen,Stadskanaal,Delfzijl|Eemsdelta,Winschoten|Oldambt,Appingedam,Westerkwartier|Leek,Het Hogeland|Uithuizen,Pekela,Westerwolde'),
  ...p('NL-FR', 'Leeuwarden,Sneek|Súdwest-Fryslân,Drachten|Smallingerland,Heerenveen,Harlingen,Franeker|Waadhoeke,Dokkum|Noardeast-Fryslân,Joure|De Fryske Marren,Lemmer,Wolvega|Weststellingwerf,Oosterwolde|Ooststellingwerf,Burgum|Tytsjerksteradiel'),
  ...p('NL-DR', 'Assen,Emmen,Hoogeveen,Meppel,Coevorden,Roden|Noordenveld,Beilen|Midden-Drenthe,Borger-Odoorn,Westerveld,De Wolden,Tynaarlo,Aa en Hunze'),
  ...p('NL-FL', 'Almere,Lelystad,Dronten,Emmeloord|Noordoostpolder,Zeewolde,Urk'),
  ...p('NL-ZE', 'Middelburg,Vlissingen,Goes,Terneuzen,Hulst,Zierikzee|Schouwen-Duiveland,Oostburg|Sluis,Tholen,Reimerswaal,Kapelle,Borsele,Veere,Noord-Beveland'),
];

export const NETHERLANDS: CountryGeography = {
  code: 'NL', name: 'Nederland', aliases: ['Nederland', 'Nederlandse', 'Nederlands', 'Holland', 'Netherlands', 'The Netherlands', 'Dutch', 'NL'],
  provinces: PROVINCES, places: PLACES,
};

export const COUNTRIES: Record<string, CountryGeography> = { NL: NETHERLANDS };

export const provinceById = (id: string) => PROVINCES.find(province => province.id === id) ?? null;
/** The display name of a province without its disambiguation suffix ("Utrecht (provincie)" -> "Utrecht"). */
export const provinceLabel = (id: string | null | undefined) => (id ? provinceById(id)?.name.replace(/ \(provincie\)$/, '') ?? id : null);

/** A province named by id, name or alias (case/diacritics-insensitive). A bare "Utrecht"/"Groningen" is the city. */
export function findProvince(value: string): Province | null {
  const raw = normalizeText(value);
  const explicit = raw.startsWith('provincie ');
  const key = raw.replace(/^provincie\s+/, '').replace(/\s*\(provincie\)$/, '');
  if (!explicit && /^(utrecht|groningen)$/.test(key) && !/\(provincie\)$/.test(raw)) return null;
  return PROVINCES.find(province => province.id.toLowerCase() === raw
    || [province.name.replace(/ \(provincie\)$/, ''), ...province.aliases].some(name => normalizeText(name).replace(/^provincie\s+/, '') === key)) ?? null;
}

/** A place by name or alias. */
export function findPlace(value: string): Place | null {
  const key = normalizeText(value);
  return PLACES.find(place => normalizeText(place.name) === key || (place.aliases ?? []).some(alias => normalizeText(alias) === key)) ?? null;
}

/** Every name a place or province is written as, longest first (for scanning text). */
export function geographyNames(): Array<{ name: string; kind: 'province' | 'place'; id: string }> {
  const names: Array<{ name: string; kind: 'province' | 'place'; id: string }> = [];
  for (const province of PROVINCES) for (const name of [province.name.replace(/ \(provincie\)$/, ''), ...province.aliases]) {
    if (/^(utrecht|groningen)$/i.test(name)) continue;
    names.push({ name, kind: 'province', id: province.id });
  }
  names.push({ name: 'provincie Utrecht', kind: 'province', id: 'NL-UT' }, { name: 'provincie Groningen', kind: 'province', id: 'NL-GR' });
  for (const place of PLACES) for (const name of [place.name, ...(place.aliases ?? [])]) names.push({ name, kind: 'place', id: place.name });
  return names.sort((a, b) => b.name.length - a.name.length);
}

/** A Dutch postcode (1234 AB). */
export const NL_POSTCODE = /\b([1-9][0-9]{3})\s?([A-RT-Z][A-Z]|S[BCE-RT-Z])\b/;
