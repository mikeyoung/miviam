(function() {
	var soundsArray = [];
	var bassArray = [];
	var fluteArray = [];
	var rhodesArray = [];
	var vibesArray = [];
	var celloArray = [];
	var m300StringsArray = [];
	var violaArray = [];
	var violinsArray = [];
	var instrumentsEnabled = false;
	var vinylEnabled = false;
	var audioEnabled = false;
	var soundPlayerArray = [];
	var sleepStartTime;
	var sleepEndTime;
	var sleepInterval;
	var sleepIntervalCounter = 0;
	var alarmStartTime;
	var alarmEndTime;
	var alarmInterval;
	var alarmIntervalCounter = 0;
	var isAnimating = false;
	
	function cueSound() {
		var randomInterval = Math.floor(Math.random()*5000);
		setTimeout(playSound,randomInterval);
	}
	
	function playSound() {
		if (instrumentsEnabled && audioEnabled) {
			var randomSound = soundsArray[Math.floor(Math.random()*(soundsArray.length))];
			randomSound.volume =  .2 + (.6)*Math.random();
			randomSound.play();
		}				
	}
	
	function updateSleepIndicator() {
		var tempDate = new Date();
		$("#sleepButton").val("Sleep (" + Math.ceil((sleepEndTime.getTime()-tempDate.getTime())/60000) + ")");
		delete tempDate;
	}
	
	function startSleepTimer() {
		clearInterval(sleepInterval);
		$("#sleepButton").attr("disabled","disabled");
		$("#sleepIndicator").css({display:"block"});
		startAudio();
		sleepStartTime = new Date();
		sleepEndTime = new Date(sleepStartTime.getTime() + 3600000);
		updateSleepIndicator();
		sleepInterval = setInterval(function(){
			var tempDate = new Date();
			updateSleepIndicator();
			if ((tempDate).getTime() > sleepEndTime.getTime()) {
				clearInterval(sleepInterval);
				$("#sleepMinutes").html("--");
				$("#sleepButton").removeAttr("disabled");
				stopAudio();
				setAlarm();
			}
			delete tempDate;
		}
		,5000);
	}
	
	function updateAlarmLabel() {
		$("#alarmCheckLabel").html("Alarm (" + $("#alarmHour").val() + ":" + $("#alarmMinute").val() + ")");
	}
	
	function setAlarm() {
		clearInterval(alarmInterval);
		updateAlarmLabel();
		if ($("#alarmCheckbox").is(':checked')) {
			$.cookie("alarmCheckbox","1",{expires: 2112});
			alarmInterval = setInterval(function(){
				var tempDate = new Date();
				if (tempDate.getHours() == parseInt($("#alarmHour").val()) && tempDate.getMinutes() == parseInt($("#alarmMinute").val())) {
					clearInterval(alarmInterval);
					$("#alarmCheckbox").removeAttr("checked");
					startSleepTimer();
				}
				delete tempDate;
			}
			,5000);
		} else {
			$.cookie("alarmCheckbox","0",{expires: 2112});
		}
	}
	
	function stopAudio() {
		clearInterval(sleepInterval);
		$("#sleepButton").val("Sleep");
		setAlarm();
		$("#sleepMinutes").html("--");
		$("#stopButton").attr("disabled","disabled");
		$("#startButton,#sleepButton").removeAttr("disabled");
		audioEnabled = false;
		setSoundPlayerArray(0);
		$("#vinylLoop")[0].pause();
		$("audio.instrument").stop();
	}
	
	function startAudio() {
		$("#startButton").attr("disabled","disabled");
		$("#stopButton").removeAttr("disabled");
		audioEnabled = true;
		playSound();
		setSoundPlayerArray(parseInt($("#totalSoundsSelect").val()));
		if (vinylEnabled) {
			$("#vinylLoop")[0].play();
		}
	}
	
	function buildSoundArray() {
		$(".instrumentCheckbox").each(function() {
			if ($(this).is(':checked')) {
				$.cookie($(this).attr("id"),"1",{expires: 2112});
			} else {
				$.cookie($(this).attr("id"),"0",{expires: 2112});
			}
		});
		
		soundsArray = [];
		$(".instrumentCheckbox").each(function() {
			if ($(this).is(':checked')) {
				soundsArray = soundsArray.concat($.makeArray($(this).data("instrumentArray")));
			}
		});
		if (soundsArray.length > 0) {
			instrumentsEnabled = true;
		} else {
			instrumentsEnabled = false;
		}
	}
	
	function populateCheckboxData() {
		$("#bassCheckbox").data("instrumentArray",bassArray);
		$("#fluteCheckbox").data("instrumentArray",fluteArray);
		$("#rhodesCheckbox").data("instrumentArray",rhodesArray);
		$("#vibesCheckbox").data("instrumentArray",vibesArray);
		$("#celloCheckbox").data("instrumentArray",celloArray);
		$("#m300StringsCheckbox").data("instrumentArray",m300StringsArray);
		$("#violaCheckbox").data("instrumentArray",violaArray);
		$("#violinsCheckbox").data("instrumentArray",violinsArray);
	}
	
	function setVinylVolume() {
		switch(parseInt($("#vinylVolumeSelect").val())) {
			case 0:
				vinylEnabled = false;
				$("#vinylLoop")[0].pause();
				break;
			case 1:
				vinylEnabled = true;
				$("#vinylLoop")[0].volume = 0.06;
				if (audioEnabled) {
					$("#vinylLoop")[0].play();
				}
				break;
			case 2:
				vinylEnabled = true;
				$("#vinylLoop")[0].volume = 0.12;
				if (audioEnabled) {
					$("#vinylLoop")[0].play();
				}
				break;
			case 3:
				vinylEnabled = true;
				$("#vinylLoop")[0].volume = 0.18;
				if (audioEnabled) {
					$("#vinylLoop")[0].play();
				}
				break;
		}
	}
	
	function setSoundPlayerArray(totalSounds) {
		for (var i=0; i<soundPlayerArray.length; i++) {
			clearInterval(soundPlayerArray[i]);
		}
		soundPlayerArray = [];
		for (var i=0; i<totalSounds; i++) {
			soundPlayerArray.push(setInterval(cueSound,5000));
		}
	}
	
	function resetToDefault() {
		var audioWasPlaying = false;
		if (audioEnabled) {
			stopAudio();
			audioWasPlaying = true;
		}
		$(".instrumentCheckbox, #vinylCheckbox").attr("checked","checked");
		$("#alarmCheckbox").removeAttr("checked");
		$("#totalSoundsSelect").val("4");
		$("#vinylVolumeSelect").val("2");
		$("#alarmHour").val("6");
		$("#alarmMinute").val("0");
		buildSoundArray();
		setVinylVolume();
		if (audioWasPlaying) {
			startAudio();
		}
		$(".instrumentCheckbox, #vinylCheckbox").each(function() {
			$.cookie($(this).attr("id"),"1",{expires: 2112});
		});
		$.cookie("alarmCheckbox","0",{expires: 2112});
		$.cookie("alarmHour","6",{expires: 2112});
		$.cookie("alarmMinute","0",{expires: 2112});
		$.cookie("totalSoundsSelect","4",{expires: 2112});
		$.cookie("vinylVolumeSelect","2",{expires: 2112});
	}
	
	function restoreState() {
		$(".instrumentCheckbox, #vinylCheckbox, #alarmCheckbox").each(function() {
			if ($.cookie($(this).attr("id")) != null) {
				if ($.cookie($(this).attr("id")) == "1") {
					$(this).attr("checked","checked");
				} else {
					$(this).removeAttr("checked");
				}
			} else {
				if ($(this).hasClass("checkedByDefault")) {
					$(this).attr("checked","checked");
				} else {
					$(this).removeAttr("checked");
				}
			}
		});
	
		if ($.cookie("totalSoundsSelect") != null) {
			$("#totalSoundsSelect").val($.cookie("totalSoundsSelect"));
		} else {
			$("#totalSoundsSelect").val("4");
		}

		if ($.cookie("vinylVolumeSelect") != null) {
			$("#vinylVolumeSelect").val($.cookie("vinylVolumeSelect"));
		} else {
			$("#vinylVolumeSelect").val("2");
		}
		
		if ($.cookie("alarmHour") != null) {
			$("#alarmHour").val($.cookie("alarmHour"));
		} else {
			$("#alarmHour").val("6");
		}
		
		if ($.cookie("alarmMinute") != null) {
			$("#alarmMinute").val($.cookie("alarmMinute"));
		} else {
			$("#alarmHour").val("0");
		}
	}
	
	$(document).ready(function() {
		$("#vinylLoop")[0].addEventListener(
			'ended',
			function() {
				$("#vinylLoop")[0].play();
			},
			false
		);
		
		$("#startButton").click(startAudio);
		$("#stopButton").click(stopAudio);
		$("#sleepButton").click(startSleepTimer);
		
		bassArray = $("audio.bass");
		fluteArray = $("audio.flute");
		rhodesArray = $("audio.rhodes");
		vibesArray = $("audio.vibes");
		celloArray = $("audio.cello");
		m300StringsArray = $("audio.m300Strings");
		violaArray = $("audio.viola");
		violinsArray = $("audio.violins");
		
		populateCheckboxData();
	
		$(".instrumentCheckbox").change(buildSoundArray);
		
		$("#alarmCheckbox").change(setAlarm);
		
		$("#totalSoundsSelect").change(function() {
			$.cookie("totalSoundsSelect",$("#totalSoundsSelect").val(),{expires: 2112});
			if (instrumentsEnabled && audioEnabled) {
				startAudio();
			}
		});
		
		$("#vinylVolumeSelect").change(function() {
			$.cookie("vinylVolumeSelect",$("#vinylVolumeSelect").val(),{expires: 2112});
			setVinylVolume();
		});
		
		$("#alarmHour,#alarmMinute").change(function() {
			updateAlarmLabel();
			$("#alarmHour,#alarmMinute").each(function() {
				$.cookie($(this).attr("id"),$(this).val(),{expires: 2112});
			});
		});
		
		$("#resetDefaultLink").click(resetToDefault);
		
		$("#showSettings").click(function() {
			if (!isAnimating) {
				isAnimating = true;
				$("#settings").show("fast",function() {
					$("#showSettings").css({display:"none"});
					$("#hideSettings").css({display:"inline"});
					$("#defaultNotes").css({visibility:"hidden"});
					isAnimating = false;
				})
			}
		});
	
		$("#hideSettings").click(function() {
			if (!isAnimating) {
				isAnimating = true;
				$("#settings").hide("fast",function() {
					$("#hideSettings").css({display:"none"});
					$("#showSettings").css({display:"inline"});
					$("#defaultNotes").css({visibility:"visible"});
					isAnimating = false;
				})
			}
		});
		
		var totalAudioClips = $("audio").length;
	
		$("audio").on("canplay", function() {
			var audioLoaded = true;
			var totalAudioLoaded = 0;
			$("audio").each(function() {
				if ($(this)[0].readyState < 3) {
					audioLoaded = false;
				} else {
					var percentageLoaded = 0;
					totalAudioLoaded++;
					percentageLoaded = Math.ceil((totalAudioLoaded * 100) / totalAudioClips);
					$("#loadingLabel").html("loading (" + percentageLoaded + "%)..."); 
					$("#loadingProgressBar").css({width:(percentageLoaded + "%")});
				}
			});
			if (audioLoaded) {
				restoreState();
				buildSoundArray();
				setVinylVolume();
				setAlarm();
				$("#loadingIndicator").css({display:"none"});
				$("#controls").css({display:"block"});
			}
		});
	});
})();