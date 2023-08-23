import wink, {CustomEntities, Detail, PartOfSpeech, Tokens} from "wink-nlp";
import model from "wink-eng-lite-web-model";
import {readFileSync} from "fs";
import {ParsedResult} from "chrono-node";
import eventController from "./eventController";
import smartDateParser from "./smartDateParser";
import {Misc} from "../misc/misc";
import {Sentence} from "../model/sentence";
import Event from "../model/event";
import {DateRange} from "../model/dateRange";

class NlpController {
	private readonly _customPatterns: {name, patterns}[];
	private readonly _secondaryCustomPatterns: {name, patterns}[];
	private _pluginPath: string;
	private _mainNLP;
	// Secondary NLP to avoid overlap between custom entities
	// e.g. John is both a noun and a proper noun
	private _secondaryNLP;
	private _ready: boolean;
	private test_list_pos: string[];
	private nouns: string[];
	private test_list_entities: string[];
	private map: Map<string[], string>;

	constructor() {
		this._ready = false;
		this._mainNLP = wink( model );
		this._secondaryNLP = wink (model);
		this._customPatterns = [];
		this._secondaryCustomPatterns = []
		this.test_list_pos = [];
		this.test_list_entities = [];
		this.map = new Map();
		this.nouns = [];
	}

	injectPath(pluginPath: string){
		this._pluginPath = pluginPath;
	}

	init(){
		this.loadPatterns();
		this._mainNLP.learnCustomEntities(this._customPatterns);
		this._secondaryNLP.learnCustomEntities(this._secondaryCustomPatterns)
		this._ready = true;
	}

	loadPatterns(){
		const nounPatternPath = `${this._pluginPath}/.noun_patterns.txt`
		const properNamePatternPath = `${this._pluginPath}/.proper_name_patterns.txt`

		const nounData = readFileSync(nounPatternPath);
		const parsedNouns = JSON.parse(nounData.toString());
		const properNameData = readFileSync(properNamePatternPath);
		const parsedProperNames = JSON.parse(properNameData.toString());

		this._secondaryNLP.learnCustomEntities([{name: "properName", patterns: parsedProperNames}]);

		this._customPatterns.push(
			// All date objects, including "may" and "march", which for some reason are not included (may I do ..., march on the Alps)
			{name: "date", patterns: ["[|DATE] [|may] [|march] ", "on DATE"]},
			// 12th of Jan 2023, second of may
			{name: "ordinalDate", patterns: ["[ORDINAL] [|ADP] [DATE|may|march] [|DATE]"]},
			// July the third
			{name: "ordinalDateReverse", patterns: [" [|DATE] [DATE|may|march] [|DET] [ORDINAL]"]},
		);
		this._customPatterns.push(
			{name: "timeRange", patterns: ["[|ADP] [TIME|CARDINAL|NUM] [|am|pm] [|ADP] [TIME|CARDINAL|NUM] [|am|pm]", "[TIME|CARDINAL] [-|/] [TIME|CARDINAL]"]},
			{name: "exactTime", patterns: ["[at|for] [CARDINAL|TIME]"]}
		)
		this._customPatterns.push({name: "intentionalVerb", patterns: ["[|AUX] [VERB] [|ADP] [|DET] [NOUN]"]});
		this._customPatterns.push({name: "purpose", patterns: ["[|PART] [VERB] [|VERB] [|ADJ] [NOUN] [|NOUN|ADJ] [|CCONJ] [|NOUN|ADJ] [|NOUN|ADJ]"]});
		this._customPatterns.push({name: "eventNoun", patterns: parsedNouns});
		this._secondaryCustomPatterns.push({name: "properName", patterns: parsedProperNames});

	}

	process(sentence: Sentence): {selection: {value, index, type}[], event: Event} | null{
		if(!this._ready){
			console.warn("Not able to process: NLP module not ready");
			return null;
		}

		// How can I uniquely identify a string as an event?
		// If the string was immutable, it could be easy, but since its structure can be modified
		// it's necessary do define three scenarios.
		// 1. The string has not been modified in any way, not syntactically nor semantically:
		//	  This mean that I can match an event with the string value - easy
		// 2. The string has been modified but just syntactically:
		//    I shouldn't create a new event just because the syntax changed, but to associate
		//	  an event to the modified string it's necessary to compute the event-related objects
		//	  from the new string (eventNoun, dates etc...)
		// 3. The string has been modified semantically (and/or syntactically):
		//	  This mean that we can not assume that the modified string is associated to an event
		//	  and therefore we need to create one.

		// First match - Syntactic check
		let matchedEvent = eventController.syntacticCheck(sentence);
		if (matchedEvent != null && matchedEvent.processed == true) return null;

		// If the syntax check fails we'll need to perform a semantic check, once
		// all the sentence elements are defined
		const auxiliaryStructures = this.getAuxiliaryStructures(sentence);
		const mainCustomEntities = auxiliaryStructures.mainCustomEntities;
		const secondaryCustomEntities = auxiliaryStructures.secondaryCustomEntities;
		const caseInsensitiveText = auxiliaryStructures.caseInsensitiveText;
		const tokens = auxiliaryStructures.tokens;
		const pos = auxiliaryStructures.pos;

		const dates = this.filterDates(mainCustomEntities);
		const properNames = this.filterProperNames(secondaryCustomEntities);
		const eventNouns = this.filterEventNoun(mainCustomEntities);
		const purposes = this.filterPurposes(mainCustomEntities);
		//console.log(purposes);

		if (dates.length == 0) return null;

		const selectedDateIndex = caseInsensitiveText.indexOf(dates[0].value);
		let selectedEventNoun = this.findEventNoun(caseInsensitiveText, eventNouns, selectedDateIndex);
		let selectedIntentionalVerb : {value, index, type, noun};
		if (selectedEventNoun.index == -1){
			selectedIntentionalVerb = this.findIntentionalVerb(auxiliaryStructures.mainCustomEntities, auxiliaryStructures.tokens, caseInsensitiveText, selectedDateIndex);
			if (selectedIntentionalVerb.index == -1) return null;
			console.log("intentionalVerb");
			selectedEventNoun = {
				value: selectedIntentionalVerb.noun,
				index: auxiliaryStructures.caseInsensitiveText.indexOf(selectedIntentionalVerb.noun),
				type: "eventNoun"
			};
		}

		// Find possible proper names (John)
		const selectedProperName = this.findProperName(sentence.value, properNames, selectedEventNoun);

		// Find possible common noun associated to the event noun (board meeting)
		const backwardsAdjAttributes = this.findAdjAttributes(tokens, pos, selectedEventNoun, selectedProperName, selectedEventNoun.index, selectedDateIndex, true);

		const forwardAdjAttributes = this.findAdjAttributes(tokens, pos, selectedEventNoun, selectedProperName, selectedEventNoun.index, selectedDateIndex);

		const cleanDates = this.cleanJunkDates(dates);
		// Fill selection array
		const selection = this.getSelectionArray(caseInsensitiveText, cleanDates, selectedEventNoun, backwardsAdjAttributes, forwardAdjAttributes, selectedProperName);

		// From natural language to dates
		const dateRange = this.parseDates(cleanDates);

		if (dateRange == undefined) return;

		// Semantic check
		if(matchedEvent == null){
			sentence.injectSemanticFields(dateRange.start, dateRange.end, selectedEventNoun.value)
			const eventTitle = this.getEventTitle(backwardsAdjAttributes, forwardAdjAttributes, selectedEventNoun, selectedProperName);
			sentence.eventNoun = eventTitle;
			matchedEvent = eventController.semanticCheck(sentence);
		}

		// Semantic check successful
		if (matchedEvent != null && matchedEvent.processed == true) return null;

		// Semantic check unsuccessful -> new event
		if (matchedEvent == null){
			const event = eventController.createNewEvent(sentence);
			return {
				selection,
				event
			};
		}

		return {
			selection,
			event: matchedEvent
		}

	}


	/*
	********************************************************************************************************************************
	*******************************************************					 *******************************************************
	******************************************************* PRIVATE METHODS  *******************************************************
	*******************************************************					 *******************************************************
	********************************************************************************************************************************
 	*/

	private getAuxiliaryStructures(sentence: Sentence): {caseInsensitiveText: string, mainCustomEntities: CustomEntities, secondaryCustomEntities: CustomEntities, tokens: Tokens, pos: PartOfSpeech[]} {
		const caseInsensitiveText = sentence.value.toLowerCase();
		const mainDoc = this._mainNLP.readDoc(caseInsensitiveText);
		const secondaryDoc = this._secondaryNLP.readDoc(caseInsensitiveText);
		const mainCustomEntities = mainDoc.customEntities();
		const secondaryCustomEntities = secondaryDoc.customEntities();
		const tokens = mainDoc.tokens();
		const pos = tokens.out(this._mainNLP.its.pos);
		return {caseInsensitiveText, mainCustomEntities, secondaryCustomEntities, tokens, pos};
	}

	private filterDates(customEntities: CustomEntities): Detail[] {
		const its = this._mainNLP.its;
		return customEntities.out(its.detail).filter(pos => {
			const p = pos as unknown as Detail;
			return (p.type == "date") || (p.type == "ordinalDate") ||
				(p.type == "ordinalDateReverse") || (p.type == "timeRange") ||
				(p.type == "exactTime") || (p.type == "duration")
		}) as Detail[];
	}

	private filterProperNames(customEntities: CustomEntities): Detail[] {
		const its = this._mainNLP.its;
		return customEntities.out(its.detail).filter(pos => (pos as unknown as Detail).type == "properName") as Detail[];
	}

	private filterEventNoun(customEntities: CustomEntities): Detail[] {
		const its = this._mainNLP.its;
		return customEntities.out(its.detail).filter(pos => ((pos as unknown as Detail).type == "eventNoun")) as Detail[];
	}

	private filterPurposes(customEntities: CustomEntities): Detail[] {
		const its = this._mainNLP.its;
		return customEntities.out(its.detail).filter(pos => ((pos as unknown as Detail).type == "purpose")) as Detail[];
	}

	private findIntentionalVerb(customEntities: CustomEntities, tokens: Tokens, text: string, selectedDateIndex: number): {value, index, type, noun} {
		const selectedIntentionalVerb = {
			value: "",
			index: -1,
			type: "",
			noun: ""
		};
		const intentionalVerbs = customEntities.out(this._mainNLP.its.detail).filter(detail => ((detail as unknown as Detail).type == "intentionalVerb")) as Detail[];
		const pos = tokens.out(this._mainNLP.its.pos)
		const tokenValue = tokens.out();
		if (intentionalVerbs.length == 0) return selectedIntentionalVerb;
		let verbDistance = 1000;
		intentionalVerbs.forEach(intentionalVerb => {
			const vIndex = text.indexOf(intentionalVerb.value);
			const distanceFromDate = Math.abs(vIndex - selectedDateIndex);
			if (distanceFromDate < verbDistance){
				verbDistance = distanceFromDate;
				selectedIntentionalVerb.value = intentionalVerb.value;
				selectedIntentionalVerb.index = vIndex;
				selectedIntentionalVerb.type = intentionalVerb.type;
			}
		})
		const verbIndex = pos.indexOf("VERB");
		const verb = tokenValue[verbIndex];
		console.log(verb);
		selectedIntentionalVerb.noun = `${verb} ${selectedIntentionalVerb.value.split(" ").last()}`;
		return selectedIntentionalVerb;
	}

	private findEventNoun(text, eventNouns, selectedVerbIndex): {value: string, index: number, type: string} {
		const selectedEventNoun = {
			value: "",
			index: -1,
			type: ""
		};
		let nounDistance = 1000;
		eventNouns.forEach(n => {
			const nIndex = text.indexOf(n.value);
			const distanceFromVerb = Math.abs(nIndex - selectedVerbIndex);
			if (distanceFromVerb < nounDistance){
				nounDistance = distanceFromVerb;
				selectedEventNoun.value = n.value;
				selectedEventNoun.index = nIndex;
				selectedEventNoun.type = n.type;
			}
		})
		return selectedEventNoun;
	}


	private findPurpose(){

	}

	// The idea:
	// Look for [|ADP] [...NOUN]
	// backwards flag -> looks back
	private findAdjAttributes(tokens, pos, selectedEventNoun, selectedProperName, eventNounIndex, selectedDateIndex, backward = false) : {value: string, index: number, type: string}[] | null {
		const selectedAdjAttributes: { value, index, type }[] = [];
		let adjOffset = 1;
		if (backward) adjOffset = -1;
		const stringTokens = tokens.out();
		const eventNounTokenIndex = stringTokens.indexOf(selectedEventNoun.value);
		if (eventNounTokenIndex <= 0) return null;
		let cumulativeIndex = 0;
		while (pos[eventNounTokenIndex + adjOffset] == "NOUN" || pos[eventNounTokenIndex + adjOffset] == "ADJ" || pos[eventNounTokenIndex + adjOffset] == "ADP" || pos[eventNounTokenIndex + adjOffset] == "PRON"){
			const adjWord = stringTokens[eventNounTokenIndex + adjOffset];
			if(selectedProperName != null && adjWord == selectedProperName.value) return null;
			const selectedAdjAttributedIndex = cumulativeIndex + (backward ? eventNounIndex - (adjWord.length + 1) : eventNounIndex + (adjWord.length + 1));
			cumulativeIndex = selectedAdjAttributedIndex;
			if (selectedAdjAttributedIndex == selectedDateIndex) return null;
			const selectedAdjAttribute = {
				value: "",
				index: -1,
				type: ""
			};
			selectedAdjAttribute.value = adjWord;
			selectedAdjAttribute.index = selectedAdjAttributedIndex
			selectedAdjAttribute.type = pos[eventNounTokenIndex + adjOffset];
			selectedAdjAttributes.push(selectedAdjAttribute);
			if (backward) adjOffset -= 1;
			else adjOffset += 1;
		}

		// The last element can't be an ADP or a PRON
		while (selectedAdjAttributes.length > 0 && (selectedAdjAttributes[selectedAdjAttributes.length - 1].type == "ADP" || selectedAdjAttributes[selectedAdjAttributes.length - 1].type == "PRON")){
			selectedAdjAttributes.pop();
		}

		if (selectedAdjAttributes.length == 0) return null;

		return selectedAdjAttributes;
	}

	private findProperName(text, properNames, selectedEventNoun) : {value: string, index: number, type: string, parsedValue: string} | null {
		const selectedProperName = {
			value: "",
			index: -1,
			type: "",
			parsedValue: ""
		};

		let properNameDistance = 1000;
		let hasAdp = false;
		let adp;
		properNames.forEach(properName => {
			const pIndex = text.toLowerCase().indexOf(properName.value);
			let caseSensitiveFirstChar = text[pIndex];
			// Checking ad-positions
			const splitValue = properName.value.split(" ");
			adp = splitValue.length == 1 ? undefined : properName.value.split(" ")[0];
			if (adp != undefined) hasAdp = true;
			if (hasAdp) caseSensitiveFirstChar = text[pIndex + adp.length + 1];
			// Excluding lower case proper names to confuse words like "amber" and "Amber"
			if (Misc.isLowerCase(caseSensitiveFirstChar)) return;
			const distanceFromEventNoun = Math.abs(pIndex - selectedEventNoun.index);
			if (distanceFromEventNoun < properNameDistance){
				properNameDistance = distanceFromEventNoun;
				selectedProperName.value = hasAdp ? splitValue[1] : splitValue[0];
				selectedProperName.index = pIndex;
				selectedProperName.type = properName.type;
			}
		});
		if (selectedProperName.index == -1) return null
		selectedProperName.parsedValue = selectedProperName.value.charAt(0).toUpperCase() + selectedProperName.value.slice(1);
		if (!hasAdp) selectedProperName.parsedValue = `with ${selectedProperName.parsedValue}`;
		else selectedProperName.parsedValue = `${adp} ${selectedProperName.parsedValue}`
		// Check if eventNoun coincides with
		return selectedProperName;
	}

	private getSelectionArray(text: string, dates: {value, index, type}[], selectedEventNoun: {value, index, type}, backwardsAdjAttributes: {value, index, type}[], forwardAdjAttributes: {value, index, type}[],  selectedProperName: {value, index, type}): {value, index, type}[] {
		const selection = []

		dates.forEach(date => {
			const dateIndex = text.indexOf(date.value);
			selection.push({value: date.value, index: dateIndex, type: date.type});
		})

		if (selectedEventNoun!= null) selection.push(selectedEventNoun);
		if (selectedProperName!= null) selection.push(selectedProperName);
		if (backwardsAdjAttributes != null){
			backwardsAdjAttributes.forEach(backwardsAdjAttribute => {
				selection.push(backwardsAdjAttribute);
			})
		}
		if (forwardAdjAttributes != null){
			forwardAdjAttributes.forEach(forwardAdjAttribute => {
				selection.push(forwardAdjAttribute);
			})
		}

		console.log(selection);

		// Order by index (builder.add needs to be called with increasing values)
		const sorted = selection.sort((a, b) => a.index - b.index);
		return sorted;
	}

	// There can be just one date (2023/01/01, The second of August ...) and/or one time (at 2, from 10 to 12);
	// I'm assuming that the first date (syntactically) is the correct one
	private cleanJunkDates(dates){
		const dateComponentPatterns = ["date", "ordinalDate", "ordinalDateReverse"];
		const timePatterns = ["exactTime", "timeRange"];
		// array.indexOf(element) > -1 is the same as array.contains(element)
		const dateComponents = dates.filter(d => dateComponentPatterns.indexOf(d.type) > -1);
		const times = dates.filter(t => timePatterns.indexOf(t.type) > -1);
		let cleanDates = dates;
		if(dateComponents.length > 1)
			cleanDates = cleanDates.filter(d => ((timePatterns.indexOf(d.type) > -1) || (d.value == dateComponents[0].value)));
		if(times.length > 1)
			cleanDates = cleanDates.filter(d =>  ((dateComponentPatterns.indexOf(d.type) > -1) || (d.value == times[0].value)));
		return cleanDates;
	}

	private parseDates(dates): DateRange {
		const timeRelatedString = dates.map(e => e.value).toString().replaceAll(",", " ");
		const parsed = smartDateParser.parse(timeRelatedString) as ParsedResult[];
		return smartDateParser.getDates(parsed);
	}

	test(sentence: Sentence) {
		const text = sentence.value;
		const sentences = text.split("\n");
		sentences.forEach(sentence => {
			const caseInsensitiveText = sentence.toLowerCase();
			const doc = this._mainNLP.readDoc(caseInsensitiveText);
			const testDoc = this._secondaryNLP.readDoc(caseInsensitiveText);
			const customEntities = doc.customEntities().out(this._mainNLP.its.detail);
			const testCustomE = testDoc.customEntities().out(this._secondaryNLP.its.detail);
			console.log("customE", customEntities);
			console.log("testCustomE", testCustomE);
			const entities = doc.entities().out(this._mainNLP.its.detail);
			const dates = entities.filter(e => e.type == "DATE");
			const tokens = doc.tokens();
			const tokenValues = tokens.out();
			const pos = tokens.out(this._mainNLP.its.pos);
			pos.forEach((p, i) => {
				if (p == "PROPN"){
					const corrispectiveToken = tokenValues[i];
					const corrispectiveDateList = dates.filter(d => d.value == corrispectiveToken)
					if (corrispectiveDateList.length > 0){
						pos[i] = corrispectiveDateList[0].type;
					}
				}
				if (p == "PUNCT"){
					pos.remove(p);
				}
				if (p == "NOUN"){
					const corrispectiveToken = tokenValues[i];
					this.nouns.push(corrispectiveToken);
				}
			})
			this.test_list_pos.push(pos);
			this.map.set(pos, sentence);
		})
	}

	print() {
		/*
		console.log("POS list")
		console.log(this.test_list_pos);
		console.log(Array.from(this.map.entries()));
		console.log("Nouns")
		console.log(this.nouns);
		 */

	}

	private getEventTitle(backwardsAdjAttributes, forwardAdjAttributes, selectedEventNoun, selectedProperName): string {
		let eventTitle = "";
		if (backwardsAdjAttributes != null){
			backwardsAdjAttributes.reverse().forEach(backwardsAdjAttribute => {
				eventTitle += `${backwardsAdjAttribute.value} `
			})
		}
		eventTitle += selectedEventNoun.value;
		if (forwardAdjAttributes != null){
			eventTitle += " "
			forwardAdjAttributes.forEach(forwardAdjAttribute => {
				eventTitle += `${forwardAdjAttribute.value} `
			})
		}
		if (selectedProperName != null) eventTitle += ` ${selectedProperName.parsedValue}`

		console.log(backwardsAdjAttributes, forwardAdjAttributes, selectedEventNoun, selectedProperName);

		return eventTitle;
	}
}

const nplController = new NlpController();
export default nplController;
